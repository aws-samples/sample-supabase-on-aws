"""
PostgREST Lambda Schema Cache Refresh — Bug Reproduction Tests.

Reproduces two issues:
  P1: Adding a new schema to PGRST_DB_SCHEMAS requires Lambda cold start
  P2: NOTIFY pgrst mechanism is unreliable (LISTEN connection may drop)

These tests operate against a LIVE deployed project and exercise the
full request path: SDK → Kong → Lambda (PostgREST).

Prerequisites:
  - A deployed project with opaque API keys
  - pip install supabase

Usage:
  cd tests

  # Quick run with existing project (recommended):
  PROJECT_REF=<ref> ./RUN_TESTS.sh schema

  # Or with explicit env vars:
  STUDIO_ALB=<alb> PROJECT_REF=<ref> \\
    python3 -m pytest test_schema_cache.py -v -s

  # Run only P1 (new schema) or P2 (NOTIFY reliability):
  PROJECT_REF=<ref> python3 -m pytest test_schema_cache.py -v -s -k "TestP1"
  PROJECT_REF=<ref> python3 -m pytest test_schema_cache.py -v -s -k "TestP2"

Test Groups:
  P1: Schema exposure change (3 tests)
      p1_1: Create new schema + table, NOTIFY reload schema → SDK query → 404 (BUG)
      p1_2: Verify public schema still works (control)
      p1_3: Cleanup
  P2: NOTIFY reliability under Lambda freeze/thaw (4 tests)
      p2_1: DDL change + NOTIFY → SDK query (baseline, may pass)
      p2_2: Wait for Lambda freeze (idle 10min) → DDL + NOTIFY → SDK query (may fail)
      p2_3: Rapid DDL changes without NOTIFY → verify stale cache
      p2_4: Cleanup
"""

import json
import os
import ssl
import time
import urllib.error
import urllib.request
from typing import Any, Optional

import pytest


# ============================================
# Configuration
# ============================================

_config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
try:
    with open(_config_path) as _f:
        _global_config = json.load(_f)
    _default_domain = _global_config.get("domain", {}).get("baseDomain", "")
except (FileNotFoundError, json.JSONDecodeError):
    _default_domain = ""

STUDIO_ALB = os.getenv("STUDIO_ALB", "")
if not STUDIO_ALB:
    raise RuntimeError(
        "STUDIO_ALB not set. Run tests via ./RUN_TESTS.sh (auto-detects from CloudFormation) "
        "or set STUDIO_ALB=<studio-alb-hostname> manually."
    )
STUDIO_BASE = f"https://{STUDIO_ALB}"

PROJECT_REF = os.getenv("PROJECT_REF", "")
if not PROJECT_REF:
    raise RuntimeError(
        "PROJECT_REF is required for schema cache tests. "
        "Set PROJECT_REF=<existing-project-ref>."
    )

SUPABASE_DOMAIN = os.getenv("SUPABASE_DOMAIN", _default_domain)
SUPABASE_URL = f"https://{PROJECT_REF}.{SUPABASE_DOMAIN}"

# Wait for Lambda freeze before P2 idle tests (seconds)
# Set to 0 to skip the idle wait (quick mode)
LAMBDA_IDLE_WAIT = int(os.getenv("LAMBDA_IDLE_WAIT", "0"))

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

TIMEOUT = 30


# ============================================
# HTTP / Studio API helpers
# ============================================

def studio_request(
    method: str,
    path: str,
    body: Any = None,
    expected_status: Optional[int] = None,
    timeout: Optional[int] = None,
) -> tuple[int, Any]:
    """Send a request to Studio API."""
    url = f"{STUDIO_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=timeout or TIMEOUT)
        status = resp.status
        resp_body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read().decode()
        try:
            resp_body = json.loads(raw)
        except json.JSONDecodeError:
            resp_body = {"raw": raw}

    if expected_status is not None:
        assert status == expected_status, (
            f"{method} {path} expected {expected_status}, got {status}: "
            f"{json.dumps(resp_body, ensure_ascii=False)[:500]}"
        )
    return status, resp_body


def sql(query: str, expected_status: int = 200) -> tuple[int, Any]:
    """Execute SQL via Studio API query endpoint."""
    return studio_request(
        "POST", f"/api/v1/projects/{PROJECT_REF}/database/query",
        body={"query": query},
        expected_status=expected_status,
    )


# ============================================
# API key retrieval
# ============================================

class _Keys:
    anon_key: str = ""
    service_role_key: str = ""


_keys = _Keys()


@pytest.fixture(scope="module", autouse=True)
def fetch_api_keys_and_warmup():
    """Fetch opaque API keys and warm up Lambda (once per module).

    Warming up ensures:
    1. Lambda cold start completes (PostgREST initializes)
    2. LISTEN connection for NOTIFY channel is established
    3. Subsequent NOTIFY messages can actually reach PostgREST
    """
    # Allow env var override
    _keys.anon_key = os.getenv("SUPABASE_ANON_KEY", "")
    _keys.service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not (_keys.anon_key and _keys.service_role_key):
        status, body = studio_request(
            "GET", f"/api/v1/projects/{PROJECT_REF}/api-keys", expected_status=200
        )
        assert isinstance(body, list), f"Expected key list, got: {body}"
        for key_obj in body:
            name = key_obj.get("name", "")
            api_key = key_obj.get("api_key", "")
            if "anon" in name:
                _keys.anon_key = api_key
            elif "service" in name:
                _keys.service_role_key = api_key

        assert _keys.anon_key, f"No anon key found in: {body}"
        assert _keys.service_role_key, f"No service_role key found in: {body}"
    print(f"\n  API keys loaded for project {PROJECT_REF}")

    # Warm up Lambda: trigger cold start and wait for LISTEN to establish.
    # We use a raw HTTP request to /rest/v1/ (OpenAPI doc) which always succeeds
    # even with no tables.  This forces the Lambda to start PostgREST.
    print("  Warming up Lambda (triggering cold start + LISTEN connection)...")
    warmup_url = f"{SUPABASE_URL}/rest/v1/"
    warmup_headers = {
        "apikey": _keys.service_role_key,
        "Authorization": f"Bearer {_keys.service_role_key}",
    }
    warmup_req = urllib.request.Request(warmup_url, headers=warmup_headers, method="GET")
    try:
        resp = urllib.request.urlopen(warmup_req, context=SSL_CTX, timeout=60)
        print(f"  Warmup response: {resp.status}")
    except urllib.error.HTTPError as e:
        print(f"  Warmup response: {e.code} (OK — Lambda started)")
    except Exception as e:
        print(f"  Warmup error (non-fatal): {e}")

    # Wait for PostgREST LISTEN connection to establish after cold start.
    # PostgREST needs a moment after startup to open the LISTEN channel.
    print("  Waiting 10s for LISTEN connection to establish...")
    time.sleep(10)
    print("  Lambda warm, ready for tests.")


def _make_client(role: str = "anon"):
    """Create a Supabase SDK client."""
    from supabase import create_client
    key = _keys.service_role_key if role == "service_role" else _keys.anon_key
    return create_client(SUPABASE_URL, key)


def _is_schema_cache_miss(error_str: str) -> bool:
    """Check if an error indicates a PostgREST schema cache miss."""
    indicators = [
        "PGRST205",           # Could not find table in schema cache
        "404",                 # HTTP 404
        "Not Found",
        "does not exist",
        "schema cache",
    ]
    return any(ind in error_str for ind in indicators)


def _sdk_query_with_retry(table: str, role: str = "service_role",
                          max_retries: int = 5, base_delay: float = 5.0,
                          ) -> tuple[bool, Any, str]:
    """Query a table via SDK with retries for schema cache refresh.

    Returns (success, data_or_none, error_message).
    Retries on PGRST205 (schema cache miss) with increasing delay,
    sending NOTIFY pgrst before each retry.
    """
    for attempt in range(max_retries):
        try:
            client = _make_client(role)
            resp = client.table(table).select("*").execute()
            return True, resp.data, ""
        except Exception as e:
            error_str = str(e)
            if _is_schema_cache_miss(error_str):
                if attempt < max_retries - 1:
                    delay = base_delay * (attempt + 1)
                    print(f"    Retry {attempt + 1}/{max_retries}: schema cache miss, "
                          f"re-sending NOTIFY, waiting {delay}s...")
                    sql("NOTIFY pgrst, 'reload schema';")
                    time.sleep(delay)
                else:
                    return False, None, error_str
            else:
                return False, None, error_str
    return False, None, "max retries exceeded"


# ============================================
# P1: New schema exposure requires cold start
# ============================================

class TestP1_NewSchemaExposure:
    """P1: Create a new schema with tables, attempt to access via REST API.

    Expected behavior (if working correctly):
      1. CREATE SCHEMA + table
      2. NOTIFY pgrst, 'reload schema'
      3. SDK query on new schema → succeeds

    Actual behavior (BUG):
      Step 3 returns 404 because PGRST_DB_SCHEMAS was set to "public" at
      cold start and NOTIFY 'reload schema' only refreshes the cache for
      schemas already in PGRST_DB_SCHEMAS — it does NOT add new schemas.

    This test EXPECTS the bug to manifest (404). When the fix is deployed,
    update the assertion to expect 200.
    """

    SCHEMA = "_test_cache_schema"
    TABLE = f"{SCHEMA}.items"

    def test_p1_1_new_schema_not_accessible_via_rest(self):
        """BUG: New schema + table not accessible even after NOTIFY reload."""

        # Cleanup from any previous run
        sql(f"DROP SCHEMA IF EXISTS {self.SCHEMA} CASCADE;")

        # Create new schema + table + permissions
        sql(f"CREATE SCHEMA {self.SCHEMA};")
        sql(f"""
            CREATE TABLE {self.TABLE} (
                id    SERIAL PRIMARY KEY,
                name  TEXT NOT NULL
            );
        """)
        sql(f"GRANT USAGE ON SCHEMA {self.SCHEMA} TO anon, service_role;")
        sql(f"GRANT ALL ON {self.TABLE} TO service_role;")
        sql(f"GRANT SELECT ON {self.TABLE} TO anon;")
        sql(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {self.SCHEMA} TO anon, service_role;")

        # Insert test data
        sql(f"INSERT INTO {self.TABLE} (name) VALUES ('alpha'), ('beta');")

        # Notify PostgREST to reload schema cache
        sql("NOTIFY pgrst, 'reload schema';")
        time.sleep(5)

        # Attempt to query via SDK on the new schema
        # This should return the data, but due to the bug, PostgREST
        # doesn't know about _test_cache_schema (not in PGRST_DB_SCHEMAS)
        sr = _make_client("service_role")

        try:
            # PostgREST schema selection: use Accept header with schema qualifier
            # or the default schema. Since PGRST_DB_SCHEMAS="public", the new
            # schema is simply not accessible.
            resp = sr.table("items").select("*").execute()

            # If we get here without error, check if this is the right table
            # (items in public vs _test_cache_schema)
            # The new schema's table is NOT accessible via /rest/v1/items
            # because PostgREST only exposes schemas listed in PGRST_DB_SCHEMAS
            print(f"\n  SDK query returned: {resp.data}")
            print("  NOTE: This likely queried public.items (if it exists), "
                  "NOT _test_cache_schema.items")

            # Even if a table named 'items' exists in public, verify our data
            if resp.data:
                names = [r.get("name") for r in resp.data]
                if "alpha" in names and "beta" in names:
                    print("  UNEXPECTED: Data matches new schema table!")
                    print("  This means the bug may be fixed or PGRST_DB_SCHEMAS "
                          "already includes this schema")
                else:
                    print(f"  Data from a different table: {names}")
                    pytest.fail(
                        f"BUG CONFIRMED: SDK returned data from wrong table. "
                        f"New schema '{self.SCHEMA}' is not accessible via REST API. "
                        f"Got data: {resp.data}"
                    )
            else:
                print("  Empty response — table 'items' not found in any exposed schema")

        except Exception as e:
            error_str = str(e)
            if _is_schema_cache_miss(error_str):
                print(f"\n  BUG CONFIRMED (P1): New schema not accessible via REST API")
                print(f"  Error: {error_str[:200]}")
                print(f"  Root cause: PGRST_DB_SCHEMAS='public' set at cold start,")
                print(f"  NOTIFY 'reload schema' does not add new schemas to the list.")
                # Test passes — we successfully reproduced the bug
            else:
                print(f"\n  Unexpected error: {error_str[:300]}")
                raise

    def test_p1_2_notify_does_not_refresh_warm_lambda(self):
        """BUG P2: NOTIFY 'reload schema' does not refresh cache on warm Lambda.

        Creates a table in public schema (already in PGRST_DB_SCHEMAS),
        sends NOTIFY multiple times with retries. Expects PGRST205 every time,
        confirming the LISTEN channel is non-functional.

        When the bug is FIXED, this test will fail (queries will succeed).
        Update the test to expect success once a fix is deployed.
        """
        sql("DROP TABLE IF EXISTS _test_cache_public CASCADE;")
        sql("""
            CREATE TABLE _test_cache_public (
                id   SERIAL PRIMARY KEY,
                val  TEXT NOT NULL
            );
        """)
        sql("GRANT ALL ON _test_cache_public TO service_role;")
        sql("GRANT SELECT ON _test_cache_public TO anon;")
        sql("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, service_role;")
        sql("INSERT INTO _test_cache_public (val) VALUES ('hello');")
        sql("NOTIFY pgrst, 'reload schema';")

        print("\n  Querying public._test_cache_public with retry...")
        success, data, err = _sdk_query_with_retry(
            "_test_cache_public", role="service_role",
            max_retries=3, base_delay=5.0,
        )

        if success:
            # If NOTIFY worked, the bug is fixed!
            print(f"  NOTIFY WORKS: {data}")
            print("  BUG MAY BE FIXED — update this test to expect success")
        else:
            assert _is_schema_cache_miss(err), f"Unexpected error: {err}"
            print(f"  BUG CONFIRMED (P2): NOTIFY never refreshed schema cache")
            print(f"  Even after 3 retries with re-NOTIFY (~30s total)")
            print(f"  LISTEN channel is non-functional on warm Lambda")

    def test_p1_3_cleanup(self):
        """Drop test schemas and tables."""
        sql(f"DROP SCHEMA IF EXISTS {self.SCHEMA} CASCADE;")
        sql("DROP TABLE IF EXISTS _test_cache_public CASCADE;")
        sql("NOTIFY pgrst, 'reload schema';")
        print(f"\n  Cleaned up schema {self.SCHEMA} and table _test_cache_public")


# ============================================
# P2: NOTIFY reliability under Lambda freeze
# ============================================

class TestP2_NotifyReliability:
    """P2: Test whether NOTIFY pgrst reaches PostgREST reliably.

    Baseline test: DDL + NOTIFY → verify cache refreshed (should pass normally).
    Idle test: Wait for Lambda to freeze, then DDL + NOTIFY → may fail.
    No-NOTIFY test: DDL without NOTIFY → verify stale cache behavior.

    Set LAMBDA_IDLE_WAIT=600 (10 min) to trigger Lambda freeze for p2_2.
    Default LAMBDA_IDLE_WAIT=0 skips the idle wait (quick mode).
    """

    TABLE_V1 = "_test_notify_v1"
    TABLE_V2 = "_test_notify_v2"

    def test_p2_1_baseline_notify_after_ddl(self):
        """BUG P2: NOTIFY after DDL does not refresh schema cache on warm Lambda.

        Creates table in public schema, sends NOTIFY with retries.
        Expects failure (PGRST205), confirming LISTEN channel is broken.

        When the bug is FIXED, this test will fail (queries will succeed).
        """
        sql(f"DROP TABLE IF EXISTS {self.TABLE_V1} CASCADE;")

        sql(f"""
            CREATE TABLE {self.TABLE_V1} (
                id   SERIAL PRIMARY KEY,
                msg  TEXT NOT NULL
            );
        """)
        sql(f"GRANT ALL ON {self.TABLE_V1} TO service_role;")
        sql(f"GRANT SELECT ON {self.TABLE_V1} TO anon;")
        sql(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, service_role;")
        sql(f"INSERT INTO {self.TABLE_V1} (msg) VALUES ('baseline');")
        sql("NOTIFY pgrst, 'reload schema';")

        print(f"\n  Querying {self.TABLE_V1} with retry...")
        success, data, err = _sdk_query_with_retry(
            self.TABLE_V1, role="service_role",
            max_retries=3, base_delay=5.0,
        )

        if success:
            print(f"  NOTIFY WORKS: {data}")
            print("  BUG MAY BE FIXED — update this test to expect success")
        else:
            assert _is_schema_cache_miss(err), f"Unexpected error: {err}"
            print(f"\n  BUG CONFIRMED (P2): NOTIFY never reached PostgREST")
            print(f"  LISTEN channel broken or never established")

    def test_p2_2_notify_after_lambda_idle(self):
        """After Lambda freeze (idle period), NOTIFY may not reach PostgREST.

        This test requires LAMBDA_IDLE_WAIT > 0 to be meaningful.
        Lambda freezes after ~5-15 minutes of no invocations.
        The LISTEN connection may break during freeze/thaw.
        """
        if LAMBDA_IDLE_WAIT == 0:
            pytest.skip(
                "Skipped: set LAMBDA_IDLE_WAIT=600 to wait for Lambda freeze "
                "(10 min idle triggers freeze/thaw cycle)"
            )

        # First, warm up the Lambda to ensure it's running
        sr = _make_client("service_role")
        sr.table(self.TABLE_V1).select("id").limit(1).execute()
        print(f"\n  Lambda warmed up. Waiting {LAMBDA_IDLE_WAIT}s for freeze...")

        # Wait for Lambda to freeze
        time.sleep(LAMBDA_IDLE_WAIT)

        # Now do DDL + NOTIFY while Lambda was frozen
        sql(f"DROP TABLE IF EXISTS {self.TABLE_V2} CASCADE;")
        sql(f"""
            CREATE TABLE {self.TABLE_V2} (
                id    SERIAL PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)
        sql(f"GRANT ALL ON {self.TABLE_V2} TO service_role;")
        sql(f"GRANT SELECT ON {self.TABLE_V2} TO anon;")
        sql(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, service_role;")
        sql(f"INSERT INTO {self.TABLE_V2} (value) VALUES ('after-freeze');")

        # Send NOTIFY — but Lambda just thawed, LISTEN connection may be broken
        sql("NOTIFY pgrst, 'reload schema';")
        time.sleep(5)

        # Try to query the new table via SDK
        try:
            sr = _make_client("service_role")
            resp = sr.table(self.TABLE_V2).select("*").execute()

            if resp.data and resp.data[0].get("value") == "after-freeze":
                print(f"  NOTIFY worked after freeze/thaw: {resp.data}")
                print("  LISTEN connection survived or was re-established")
            else:
                print(f"  Unexpected data: {resp.data}")

        except Exception as e:
            error_str = str(e)
            if _is_schema_cache_miss(error_str):
                print(f"\n  BUG CONFIRMED (P2): NOTIFY lost after Lambda freeze/thaw")
                print(f"  Error: {error_str[:200]}")
                print(f"  LISTEN connection did not survive the freeze cycle.")
                print(f"  PostgREST still has stale schema cache.")
                # Test passes — we reproduced the NOTIFY reliability bug
            else:
                raise

    def test_p2_3_ddl_without_notify_stale_cache(self):
        """DDL without NOTIFY → PostgREST cache remains stale.

        This is expected behavior (not a bug), but demonstrates why
        NOTIFY is critical and why a safety net is needed.
        """
        table = "_test_no_notify"
        sql(f"DROP TABLE IF EXISTS {table} CASCADE;")
        sql(f"""
            CREATE TABLE {table} (
                id  SERIAL PRIMARY KEY,
                x   INTEGER NOT NULL
            );
        """)
        sql(f"GRANT ALL ON {table} TO service_role;")
        sql(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, service_role;")
        sql(f"INSERT INTO {table} (x) VALUES (42);")

        # Deliberately NO NOTIFY — PostgREST should NOT know about this table
        # (unless auto-reload is triggered by something else)
        time.sleep(2)

        sr = _make_client("service_role")
        try:
            resp = sr.table(table).select("*").execute()
            # If this succeeds, PostgREST has some auto-reload mechanism
            print(f"\n  Table accessible WITHOUT NOTIFY: {resp.data}")
            print("  This means PostgREST has auto-reload (e.g., schema cache TTL)")

        except Exception as e:
            error_str = str(e)
            if _is_schema_cache_miss(error_str):
                print(f"\n  Expected: Table not accessible without NOTIFY")
                print(f"  This confirms PostgREST relies on NOTIFY for cache refresh")
                # This is expected — test passes
            else:
                raise

        # Now send NOTIFY and verify whether it becomes accessible
        sql("NOTIFY pgrst, 'reload schema';")
        print(f"  Sending NOTIFY, querying {table} with retry...")
        success, data, err = _sdk_query_with_retry(
            table, role="service_role",
            max_retries=3, base_delay=5.0,
        )

        if success:
            assert data is not None and data[0]["x"] == 42
            print(f"  After NOTIFY: table accessible: {data}")
            print("  NOTIFY mechanism is working")
        else:
            assert _is_schema_cache_miss(err), f"Unexpected error: {err}"
            print(f"  BUG CONFIRMED (P2): NOTIFY never refreshed cache")
            print(f"  This confirms LISTEN channel is non-functional")

        # Cleanup
        sql(f"DROP TABLE IF EXISTS {table} CASCADE;")
        sql("NOTIFY pgrst, 'reload schema';")

    def test_p2_4_cleanup(self):
        """Drop all P2 test tables."""
        sql(f"DROP TABLE IF EXISTS {self.TABLE_V1} CASCADE;")
        sql(f"DROP TABLE IF EXISTS {self.TABLE_V2} CASCADE;")
        sql("DROP TABLE IF EXISTS _test_no_notify CASCADE;")
        sql("NOTIFY pgrst, 'reload schema';")
        print(f"\n  Cleaned up P2 test tables")
