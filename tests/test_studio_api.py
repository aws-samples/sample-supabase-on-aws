"""
Studio Management API integration tests.

Tests the unified /api/v1/projects/* endpoints that Studio exposes
for project lifecycle management.

Flow:
  1. POST /api/v1/projects              → create project (get ref)
  2. GET  /api/v1/projects/{ref}/api-keys → retrieve API keys
  3. POST /api/v1/projects/{ref}/database/query → execute SQL
  4. POST /api/v1/projects/{ref}/secrets  → configure env vars (TODO: not yet implemented)

Usage:
  cd tests
  STUDIO_ALB=studio-alb-XXXX.us-west-2.elb.amazonaws.com \
    python3 -m pytest test_studio_api.py -v -s

  # To skip project creation and test against an existing project:
  STUDIO_ALB=... PROJECT_REF=kb30s7yaaaj5s6s2xn4s \
    python3 -m pytest test_studio_api.py -v -s

  # To keep the test project after tests complete (skip cleanup):
  STUDIO_ALB=... KEEP_PROJECT=1 \
    python3 -m pytest test_studio_api.py -v -s
"""

import json
import os
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any, Optional

import pytest

# ============================================
# Configuration
# ============================================

# Auto-detect from config.json if env vars not set
_config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
try:
    with open(_config_path) as _f:
        _global_config = json.load(_f)
    _default_domain = _global_config.get("domain", {}).get("baseDomain", "")
except (FileNotFoundError, json.JSONDecodeError):
    _default_domain = ""

# STUDIO_ALB: set by RUN_TESTS.sh (auto-detected from CloudFormation), or manually
STUDIO_ALB = os.getenv("STUDIO_ALB", "")
if not STUDIO_ALB:
    raise RuntimeError(
        "STUDIO_ALB not set. Run tests via ./RUN_TESTS.sh (auto-detects from CloudFormation) "
        "or set STUDIO_ALB=<studio-alb-hostname> manually."
    )
STUDIO_BASE = f"https://{STUDIO_ALB}"

# If set, skip project creation and use this existing project
EXISTING_PROJECT_REF = os.getenv("PROJECT_REF", "")

# If set, don't delete the test project after tests
KEEP_PROJECT = os.getenv("KEEP_PROJECT", "")

# Supabase domain for SDK tests (Kong ALB serves *.{domain})
SUPABASE_DOMAIN = os.getenv("SUPABASE_DOMAIN", _default_domain)

# SSL context (ALB uses ACM cert, skip verification for direct ALB access)
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

TIMEOUT = 30  # seconds


# ============================================
# HTTP helpers
# ============================================

def api_request(
    method: str,
    path: str,
    body: Any = None,
    expected_status: Optional[int] = None,
    timeout: Optional[int] = None,
) -> tuple[int, Any]:
    """Send a request to Studio API and return (status_code, parsed_json)."""
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
            f"{method} {path} expected {expected_status}, got {status}: {json.dumps(resp_body, ensure_ascii=False)[:500]}"
        )
    return status, resp_body


def _wait_for_schema_ready(table: str, api_key: str, max_attempts: int = 8):
    """Wait until PostgREST Lambda picks up a newly created table.

    In Lambda, PostgREST LISTEN/NOTIFY has a race condition during
    freeze/unfreeze cycles. This helper:
      1. Pings the REST root to unfreeze the Lambda
      2. Re-sends NOTIFY so the active LISTEN connection receives it
      3. Retries a table-specific GET until the schema is loaded
    """
    rest_base = f"https://{_state.ref}.{SUPABASE_DOMAIN}/rest/v1"
    headers = {"apikey": api_key, "Authorization": f"Bearer {api_key}"}

    # Step 1: ping root to unfreeze Lambda
    req = urllib.request.Request(f"{rest_base}/", headers=headers, method="GET")
    try:
        urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
    except Exception:
        pass

    # Step 2: re-send NOTIFY now that Lambda is awake
    api_request("POST", f"/api/v1/projects/{_state.ref}/database/query",
                body={"query": "NOTIFY pgrst, 'reload schema';"})
    time.sleep(5)

    # Step 3: retry until table is visible
    for attempt in range(max_attempts):
        url = f"{rest_base}/{table}?limit=1"
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
            if resp.status == 200:
                return attempt + 1
        except urllib.error.HTTPError:
            pass
        api_request("POST", f"/api/v1/projects/{_state.ref}/database/query",
                    body={"query": "NOTIFY pgrst, 'reload schema';"})
        time.sleep(3)

    raise AssertionError(
        f"PostgREST did not pick up table {table} after {max_attempts} retries"
    )


# ============================================
# Shared state across tests (module-scoped)
# ============================================

class ProjectState:
    """Holds test project state shared across all test cases."""
    ref: str = ""
    name: str = ""
    anon_key: str = ""
    service_role_key: str = ""
    created_by_test: bool = False


_state = ProjectState()

# Pre-populate from env var so individual test groups can run without TestA
if EXISTING_PROJECT_REF:
    _state.ref = EXISTING_PROJECT_REF


# ============================================
# A: Project creation
# ============================================

class TestA_CreateProject:
    """A: POST /api/v1/projects — create a new project."""

    def test_a1_create_project(self):
        """Create a test project via Studio API and capture ref + keys."""
        if EXISTING_PROJECT_REF:
            _state.ref = EXISTING_PROJECT_REF
            _state.created_by_test = False
            pytest.skip(f"Using existing project: {EXISTING_PROJECT_REF}")

        ts = datetime.now(tz=None).strftime("%m%d%H%M%S")
        project_name = f"test-api-{ts}"

        status, body = api_request("POST", "/api/v1/projects", body={
            "name": project_name,
        }, timeout=300)  # TM provisions DB + Lambda + Kong consumers

        assert status == 201, (
            f"Project creation failed with {status}: {json.dumps(body, ensure_ascii=False)[:500]}"
        )

        assert "ref" in body, f"Response missing 'ref': {body}"
        assert body["name"] == project_name
        assert body["status"] == "ACTIVE_HEALTHY"

        _state.ref = body["ref"]
        _state.name = body["name"]
        _state.created_by_test = True

        # Keys may or may not be in creation response (TM returns them separately)
        if "anon_key" in body:
            _state.anon_key = body["anon_key"]
            _state.service_role_key = body.get("service_role_key", "")

        print(f"\n  Project created: ref={_state.ref}, name={_state.name}")
        print(f"  Keys in response: {'yes' if _state.anon_key else 'no (will fetch via api-keys)'}")

    def test_a2_project_appears_in_list(self):
        """Verify the created project appears in GET /api/v1/projects."""
        assert _state.ref, "No project ref (test_a1 must run first)"

        status, body = api_request("GET", "/api/v1/projects", expected_status=200)
        assert isinstance(body, list), f"Expected array, got: {type(body)}"

        refs = [p.get("ref") for p in body]
        assert _state.ref in refs, (
            f"Project {_state.ref} not found in project list: {refs}"
        )

        project = next(p for p in body if p["ref"] == _state.ref)
        assert project["status"] == "ACTIVE_HEALTHY"
        print(f"\n  Project {_state.ref} found in list, status={project['status']}")


# ============================================
# B: API keys
# ============================================

class TestB_APIKeys:
    """B: GET /api/v1/projects/{ref}/api-keys — retrieve project API keys."""

    def test_b1_list_api_keys(self):
        """Retrieve API keys and verify anon + service_role are present."""
        assert _state.ref, "No project ref"

        status, body = api_request(
            "GET", f"/api/v1/projects/{_state.ref}/api-keys", expected_status=200
        )
        assert isinstance(body, list), f"Expected array, got: {type(body)}"
        assert len(body) >= 2, f"Expected at least 2 keys, got {len(body)}"

        key_names = [k.get("name") for k in body]
        assert "anon" in key_names, f"'anon' key not found in: {key_names}"
        assert "service_role" in key_names, f"'service_role' key not found in: {key_names}"

        for key in body:
            assert "api_key" in key, f"Key missing 'api_key' field: {key}"
            assert len(key["api_key"]) > 0, f"Empty api_key for {key.get('name')}"

        # Always capture keys here (creation response may not include them)
        anon = next(k for k in body if k["name"] == "anon")
        sr = next(k for k in body if k["name"] == "service_role")
        _state.anon_key = anon["api_key"]
        _state.service_role_key = sr["api_key"]

        print(f"\n  Found {len(body)} API keys: {key_names}")
        print(f"  anon_key: {_state.anon_key[:40]}...")
        print(f"  service_role_key: {_state.service_role_key[:40]}...")

    def test_b2_keys_match_creation_response(self):
        """If project was created by test and keys were in response, verify they match."""
        if not _state.created_by_test:
            pytest.skip("Using existing project, cannot verify key match")

        status, body = api_request(
            "GET", f"/api/v1/projects/{_state.ref}/api-keys", expected_status=200
        )

        anon = next((k for k in body if k["name"] == "anon"), None)
        sr = next((k for k in body if k["name"] == "service_role"), None)
        assert anon is not None
        assert sr is not None

        # Capture keys (needed for downstream tests regardless)
        _state.anon_key = anon["api_key"]
        _state.service_role_key = sr["api_key"]
        print(f"\n  anon_key: {_state.anon_key[:40]}...")
        print(f"  service_role_key: {_state.service_role_key[:40]}...")


# ============================================
# C: Database query
# ============================================

class TestC_DatabaseQuery:
    """C: POST /api/v1/projects/{ref}/database/query — execute SQL."""

    QUERY_PATH = property(lambda self: f"/api/v1/projects/{_state.ref}/database/query")

    def test_c1_select_one(self):
        """Sanity check: SELECT 1."""
        assert _state.ref, "No project ref"

        status, body = api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": "SELECT 1 AS ok"},
            expected_status=200,
        )
        assert isinstance(body, list), f"Expected array result, got: {type(body)}"
        assert len(body) == 1
        assert body[0]["ok"] == 1
        print(f"\n  SELECT 1 => {body}")

    def test_c2_create_table(self):
        """Create a test table in the project database."""
        assert _state.ref, "No project ref"

        sql = """
        CREATE TABLE IF NOT EXISTS _test_studio_api (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            value TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        """
        status, body = api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": sql},
            expected_status=200,
        )
        print(f"\n  CREATE TABLE => {body}")

    def test_c3_insert_rows(self):
        """Insert test rows into the table."""
        assert _state.ref, "No project ref"

        sql = """
        INSERT INTO _test_studio_api (name, value) VALUES
            ('key_1', 'hello'),
            ('key_2', 'world'),
            ('key_3', NULL)
        RETURNING id, name, value;
        """
        status, body = api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": sql},
            expected_status=200,
        )
        assert isinstance(body, list)
        assert len(body) == 3, f"Expected 3 inserted rows, got {len(body)}"
        names = [r["name"] for r in body]
        assert names == ["key_1", "key_2", "key_3"]
        print(f"\n  INSERT 3 rows => ids={[r['id'] for r in body]}")

    def test_c4_select_rows(self):
        """Query inserted rows back."""
        assert _state.ref, "No project ref"

        sql = "SELECT id, name, value FROM _test_studio_api ORDER BY id;"
        status, body = api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": sql},
            expected_status=200,
        )
        assert isinstance(body, list)
        assert len(body) == 3
        assert body[0]["name"] == "key_1"
        assert body[0]["value"] == "hello"
        assert body[2]["value"] is None  # key_3 has NULL value
        print(f"\n  SELECT => {len(body)} rows, first={body[0]}")

    def test_c5_update_row(self):
        """Update a row and verify."""
        assert _state.ref, "No project ref"

        sql = """
        UPDATE _test_studio_api
        SET value = 'updated'
        WHERE name = 'key_3'
        RETURNING id, name, value;
        """
        status, body = api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": sql},
            expected_status=200,
        )
        assert len(body) == 1
        assert body[0]["value"] == "updated"
        print(f"\n  UPDATE key_3 => {body[0]}")

    def test_c6_delete_row(self):
        """Delete a row and verify count."""
        assert _state.ref, "No project ref"

        sql = "DELETE FROM _test_studio_api WHERE name = 'key_2' RETURNING id;"
        status, body = api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": sql},
            expected_status=200,
        )
        assert len(body) == 1
        print(f"\n  DELETE key_2 => removed id={body[0]['id']}")

        # Verify remaining count
        sql2 = "SELECT COUNT(*)::int AS cnt FROM _test_studio_api;"
        _, body2 = api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": sql2},
            expected_status=200,
        )
        assert body2[0]["cnt"] == 2
        print(f"  Remaining rows: {body2[0]['cnt']}")

    def test_c7_invalid_sql_returns_error(self):
        """Invalid SQL should return an error, not 200."""
        assert _state.ref, "No project ref"

        status, body = api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": "SELECT * FROM nonexistent_table_xyz_12345"},
        )
        # postgres-meta returns 400 or 500 for SQL errors
        assert status >= 400, f"Expected error status, got {status}: {body}"
        print(f"\n  Invalid SQL => {status}: {str(body)[:200]}")

    def test_c8_cleanup_table(self):
        """Drop the test table."""
        assert _state.ref, "No project ref"

        sql = "DROP TABLE IF EXISTS _test_studio_api;"
        status, body = api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": sql},
            expected_status=200,
        )
        print(f"\n  DROP TABLE => done")


# ============================================
# D: Database metadata endpoints
# ============================================

class TestD_DatabaseMetadata:
    """D: GET /api/v1/projects/{ref}/database/* — metadata endpoints."""

    METADATA_ENDPOINTS = [
        "tables",
        "extensions",
        "views",
        "types",
        "triggers",
        "policies",
        "publications",
        "foreign-tables",
        "materialized-views",
    ]

    def test_d1_all_metadata_endpoints_return_200(self):
        """All database metadata GET endpoints should return 200 with JSON arrays."""
        assert _state.ref, "No project ref"

        results = []
        for ep in self.METADATA_ENDPOINTS:
            path = f"/api/v1/projects/{_state.ref}/database/{ep}"
            status, body = api_request("GET", path)
            results.append((ep, status, type(body).__name__, len(str(body))))
            assert status == 200, f"{ep} returned {status}: {str(body)[:200]}"
            assert isinstance(body, list), f"{ep} expected array, got {type(body)}"

        print("\n  Metadata endpoint results:")
        for ep, st, tp, sz in results:
            print(f"    {ep:25s} => {st}  type={tp}  size={sz}")

    def test_d2_new_path_matches_old_path(self):
        """New /api/v1/... paths should return same data as old /api/platform/pg-meta/... paths."""
        assert _state.ref, "No project ref"

        mismatches = []
        for ep in self.METADATA_ENDPOINTS:
            new_path = f"/api/v1/projects/{_state.ref}/database/{ep}"
            old_path = f"/api/platform/pg-meta/{_state.ref}/{ep}"

            _, new_body = api_request("GET", new_path, expected_status=200)
            _, old_body = api_request("GET", old_path, expected_status=200)

            new_json = json.dumps(new_body, sort_keys=True)
            old_json = json.dumps(old_body, sort_keys=True)

            if new_json != old_json:
                mismatches.append(ep)

        assert not mismatches, f"New/old path data mismatch for: {mismatches}"
        print(f"\n  All {len(self.METADATA_ENDPOINTS)} endpoints: new path == old path")


# ============================================
# F: Table-level CRUD (SQL + metadata verification)
# ============================================

class TestF_TableCRUD:
    """F: Create table via SQL, perform data CRUD, verify via metadata endpoints.

    Tests the integration between /database/query (SQL execution)
    and /database/tables (metadata retrieval):
      f1: CREATE TABLE with columns, constraints, and defaults
      f2: Verify table appears in GET /database/tables with correct schema
      f3: INSERT rows and verify returned data
      f4: SELECT with filtering, ordering, and pagination
      f5: UPDATE rows and verify changes
      f6: DELETE rows and verify removal
      f7: ALTER TABLE — add column, verify in metadata
      f8: DROP TABLE and verify removal from metadata
    """

    TABLE_NAME = "_test_crud_table"

    def _query(self, sql, expected_status=200):
        """Helper: execute SQL via query endpoint."""
        return api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": sql},
            expected_status=expected_status,
        )

    def _get_tables(self):
        """Helper: get all tables from metadata endpoint."""
        _, body = api_request(
            "GET", f"/api/v1/projects/{_state.ref}/database/tables",
            expected_status=200,
        )
        return body

    def _find_table(self, tables, name=None):
        """Helper: find our test table in the metadata list."""
        target = name or self.TABLE_NAME
        return next((t for t in tables if t.get("name") == target), None)

    # --- f1: CREATE TABLE ---

    def test_f1_create_table(self):
        """Create a test table with typed columns, PK, defaults, and constraints."""
        assert _state.ref, "No project ref"

        # Drop if leftover from a previous failed run
        self._query(f"DROP TABLE IF EXISTS {self.TABLE_NAME};")

        sql = f"""
        CREATE TABLE {self.TABLE_NAME} (
            id       SERIAL PRIMARY KEY,
            name     TEXT NOT NULL,
            email    TEXT UNIQUE,
            age      INTEGER CHECK (age >= 0),
            active   BOOLEAN DEFAULT true,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        """
        status, body = self._query(sql)
        assert status == 200, f"CREATE TABLE failed: {body}"
        print(f"\n  CREATE TABLE {self.TABLE_NAME} => done")

    # --- f2: Verify in metadata ---

    def test_f2_verify_table_in_metadata(self):
        """Verify the table appears in GET /database/tables with correct columns."""
        assert _state.ref, "No project ref"

        tables = self._get_tables()
        table = self._find_table(tables)
        assert table is not None, (
            f"Table {self.TABLE_NAME} not found in metadata. "
            f"Available: {[t['name'] for t in tables if not t['name'].startswith('pg_')][:20]}"
        )

        # Verify basic properties
        assert table["schema"] == "public"

        # Verify columns exist
        col_names = [c["name"] for c in table.get("columns", [])]
        expected_cols = ["id", "name", "email", "age", "active", "created_at"]
        for col in expected_cols:
            assert col in col_names, f"Column '{col}' missing. Found: {col_names}"

        # Verify primary key
        pk_names = [pk["name"] for pk in table.get("primary_keys", [])]
        assert "id" in pk_names, f"PK 'id' not found. PKs: {pk_names}"

        print(f"\n  Table {self.TABLE_NAME} found in metadata")
        print(f"    columns: {col_names}")
        print(f"    primary_keys: {pk_names}")

    # --- f3: INSERT ---

    def test_f3_insert_rows(self):
        """Insert multiple rows and verify RETURNING data."""
        assert _state.ref, "No project ref"

        sql = f"""
        INSERT INTO {self.TABLE_NAME} (name, email, age, active) VALUES
            ('Alice',   'alice@test.com',   30, true),
            ('Bob',     'bob@test.com',     25, true),
            ('Charlie', 'charlie@test.com', 35, false),
            ('Diana',   'diana@test.com',   28, true),
            ('Eve',     'eve@test.com',     22, false)
        RETURNING id, name, email, age, active;
        """
        status, body = self._query(sql)
        assert isinstance(body, list), f"Expected array, got: {type(body)}"
        assert len(body) == 5, f"Expected 5 rows, got {len(body)}"

        names = [r["name"] for r in body]
        assert names == ["Alice", "Bob", "Charlie", "Diana", "Eve"]

        # Verify types
        assert body[0]["active"] is True
        assert body[2]["active"] is False
        assert isinstance(body[0]["age"], int)

        print(f"\n  INSERT 5 rows => ids={[r['id'] for r in body]}")
        for r in body:
            print(f"    {r['id']}: {r['name']}, {r['email']}, age={r['age']}, active={r['active']}")

    # --- f4: SELECT ---

    def test_f4_select_with_filters(self):
        """SELECT with WHERE, ORDER BY, LIMIT, OFFSET."""
        assert _state.ref, "No project ref"

        # 4a: Basic select all
        _, all_rows = self._query(
            f"SELECT * FROM {self.TABLE_NAME} ORDER BY id;"
        )
        assert len(all_rows) == 5, f"Expected 5 rows, got {len(all_rows)}"
        print(f"\n  4a: SELECT * => {len(all_rows)} rows")

        # 4b: WHERE filter
        _, filtered = self._query(
            f"SELECT name, age FROM {self.TABLE_NAME} WHERE active = true ORDER BY age;"
        )
        active_names = [r["name"] for r in filtered]
        assert "Charlie" not in active_names, "Charlie (active=false) should be filtered out"
        assert "Eve" not in active_names, "Eve (active=false) should be filtered out"
        assert len(filtered) == 3
        # Verify ordering by age
        ages = [r["age"] for r in filtered]
        assert ages == sorted(ages), f"Expected ascending ages, got {ages}"
        print(f"  4b: WHERE active=true ORDER BY age => {active_names}, ages={ages}")

        # 4c: LIMIT + OFFSET (pagination)
        _, page1 = self._query(
            f"SELECT name FROM {self.TABLE_NAME} ORDER BY id LIMIT 2 OFFSET 0;"
        )
        _, page2 = self._query(
            f"SELECT name FROM {self.TABLE_NAME} ORDER BY id LIMIT 2 OFFSET 2;"
        )
        _, page3 = self._query(
            f"SELECT name FROM {self.TABLE_NAME} ORDER BY id LIMIT 2 OFFSET 4;"
        )
        p1_names = [r["name"] for r in page1]
        p2_names = [r["name"] for r in page2]
        p3_names = [r["name"] for r in page3]
        assert len(page1) == 2
        assert len(page2) == 2
        assert len(page3) == 1  # Only 5 rows total
        # No overlap
        all_paged = p1_names + p2_names + p3_names
        assert len(set(all_paged)) == 5, f"Pages should cover all 5 rows: {all_paged}"
        print(f"  4c: Pagination => page1={p1_names}, page2={p2_names}, page3={p3_names}")

        # 4d: Aggregate
        _, agg = self._query(
            f"SELECT COUNT(*)::int AS cnt, AVG(age)::numeric(5,1) AS avg_age FROM {self.TABLE_NAME};"
        )
        assert agg[0]["cnt"] == 5
        print(f"  4d: Aggregate => count={agg[0]['cnt']}, avg_age={agg[0]['avg_age']}")

    # --- f5: UPDATE ---

    def test_f5_update_rows(self):
        """UPDATE rows with various conditions and verify changes."""
        assert _state.ref, "No project ref"

        # 5a: Update single row
        _, updated = self._query(
            f"UPDATE {self.TABLE_NAME} SET age = 31 WHERE name = 'Alice' RETURNING name, age;"
        )
        assert len(updated) == 1
        assert updated[0]["age"] == 31
        print(f"\n  5a: UPDATE Alice age=31 => {updated[0]}")

        # 5b: Update multiple rows
        _, updated_multi = self._query(
            f"UPDATE {self.TABLE_NAME} SET active = true WHERE active = false RETURNING name, active;"
        )
        assert len(updated_multi) == 2  # Charlie and Eve
        names = sorted([r["name"] for r in updated_multi])
        assert names == ["Charlie", "Eve"]
        print(f"  5b: UPDATE active=true WHERE false => {names}")

        # 5c: Verify final state
        _, verify = self._query(
            f"SELECT name, age, active FROM {self.TABLE_NAME} ORDER BY id;"
        )
        assert all(r["active"] is True for r in verify), "All rows should be active now"
        alice = next(r for r in verify if r["name"] == "Alice")
        assert alice["age"] == 31
        print(f"  5c: All rows active, Alice age={alice['age']}")

    # --- f6: DELETE ---

    def test_f6_delete_rows(self):
        """DELETE rows and verify removal."""
        assert _state.ref, "No project ref"

        # 6a: Delete single row
        _, deleted = self._query(
            f"DELETE FROM {self.TABLE_NAME} WHERE name = 'Eve' RETURNING id, name;"
        )
        assert len(deleted) == 1
        assert deleted[0]["name"] == "Eve"
        print(f"\n  6a: DELETE Eve => id={deleted[0]['id']}")

        # 6b: Verify count
        _, count_check = self._query(
            f"SELECT COUNT(*)::int AS cnt FROM {self.TABLE_NAME};"
        )
        assert count_check[0]["cnt"] == 4
        print(f"  6b: Remaining rows: {count_check[0]['cnt']}")

        # 6c: Delete with condition
        _, deleted_cond = self._query(
            f"DELETE FROM {self.TABLE_NAME} WHERE age < 28 RETURNING name, age;"
        )
        deleted_names = [r["name"] for r in deleted_cond]
        print(f"  6c: DELETE WHERE age<28 => {deleted_names}")

        # 6d: Verify remaining
        _, remaining = self._query(
            f"SELECT name, age FROM {self.TABLE_NAME} ORDER BY id;"
        )
        remaining_names = [r["name"] for r in remaining]
        for r in remaining:
            assert r["age"] >= 28, f"{r['name']} age={r['age']} should be >= 28"
        print(f"  6d: Remaining: {remaining_names}")

    # --- f7: ALTER TABLE ---

    def test_f7_alter_table_add_column(self):
        """ALTER TABLE to add a column, verify in metadata."""
        assert _state.ref, "No project ref"

        # Add a new column
        self._query(
            f"ALTER TABLE {self.TABLE_NAME} ADD COLUMN bio TEXT DEFAULT '';"
        )
        print(f"\n  ALTER TABLE ADD COLUMN bio => done")

        # Verify in metadata
        tables = self._get_tables()
        table = self._find_table(tables)
        assert table is not None
        col_names = [c["name"] for c in table.get("columns", [])]
        assert "bio" in col_names, f"Column 'bio' not found after ALTER. Columns: {col_names}"
        print(f"  Metadata columns after ALTER: {col_names}")

        # Verify the new column works
        _, updated = self._query(
            f"UPDATE {self.TABLE_NAME} SET bio = 'test bio' WHERE name = 'Alice' RETURNING name, bio;"
        )
        assert updated[0]["bio"] == "test bio"
        print(f"  UPDATE bio => {updated[0]}")

    # --- f8: DROP TABLE ---

    def test_f8_drop_table_and_verify(self):
        """DROP TABLE and verify it disappears from metadata."""
        assert _state.ref, "No project ref"

        self._query(f"DROP TABLE {self.TABLE_NAME};")
        print(f"\n  DROP TABLE {self.TABLE_NAME} => done")

        # Verify gone from metadata
        tables = self._get_tables()
        table = self._find_table(tables)
        assert table is None, f"Table {self.TABLE_NAME} should not exist after DROP"
        print(f"  Verified: table removed from metadata")


# ============================================
# G: SDK Table CRUD (Studio API + Supabase SDK)
# ============================================

class TestG_SDKTableCRUD:
    """G: Create table via Studio API, test data CRUD via Supabase SDK.

    End-to-end flow:
      1. Studio API (pg-meta) creates table + RLS policies
      2. Supabase SDK (Kong → PostgREST Lambda) performs data operations

    Requires TestA (project creation) + TestB (API keys) to run first,
    or provide env vars: PROJECT_REF, ANON_KEY, SERVICE_ROLE_KEY.

    Tests:
      g1: Create table with RLS via Studio API
      g2: service_role INSERT via SDK
      g3: service_role SELECT via SDK
      g3b: service_role SELECT desc order + limit (pagination)
      g4: anon SELECT via SDK (RLS allows read)
      g5: anon INSERT denied via SDK (RLS blocks write)
      g6: service_role UPDATE via SDK
      g7: service_role DELETE via SDK
      g8: upsert — insert new + update existing via conflict
      g9: Cleanup — drop table via Studio API
    """

    TABLE = "_test_sdk_crud"

    def _query(self, sql, expected_status=200):
        """Execute SQL via Studio API query endpoint."""
        return api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": sql},
            expected_status=expected_status,
        )

    def _sdk_url(self):
        return f"https://{_state.ref}.{SUPABASE_DOMAIN}"

    def _make_anon_client(self):
        from supabase import create_client
        return create_client(self._sdk_url(), _state.anon_key)

    def _make_sr_client(self):
        from supabase import create_client
        return create_client(self._sdk_url(), _state.service_role_key)

    # --- g1: Setup ---

    def test_g1_create_table_with_rls(self):
        """Create table, grant permissions, enable RLS with policies via Studio API."""
        assert _state.ref, "No project ref (TestA must run first)"
        assert _state.anon_key, "No anon key (TestB must run first)"

        # Drop if leftover from a previous failed run
        self._query(f"DROP TABLE IF EXISTS {self.TABLE} CASCADE;")

        # Create table
        self._query(f"""
            CREATE TABLE {self.TABLE} (
                id         SERIAL PRIMARY KEY,
                title      TEXT NOT NULL,
                done       BOOLEAN DEFAULT false,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        """)

        # Grant permissions to PostgREST roles
        self._query(f"""
            GRANT ALL ON {self.TABLE} TO service_role;
            GRANT SELECT ON {self.TABLE} TO anon;
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, service_role;
        """)

        # Enable RLS
        self._query(f"""
            ALTER TABLE {self.TABLE} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE {self.TABLE} FORCE ROW LEVEL SECURITY;
        """)

        # RLS policies: anon can only SELECT, service_role has full access
        self._query(f"""
            CREATE POLICY "anon_read" ON {self.TABLE}
                FOR SELECT TO anon USING (true);
        """)
        self._query(f"""
            CREATE POLICY "sr_all" ON {self.TABLE}
                FOR ALL TO service_role USING (true) WITH CHECK (true);
        """)

        # Notify PostgREST to reload schema cache
        self._query("NOTIFY pgrst, 'reload schema';")
        time.sleep(3)

        attempts = _wait_for_schema_ready(self.TABLE, _state.service_role_key)
        print(f"\n  Table {self.TABLE} created with RLS (schema ready after {attempts} attempt(s))")
        print(f"    anon: SELECT only")
        print(f"    service_role: full CRUD")
        print(f"  SDK URL: {self._sdk_url()}")

    # --- g2: service_role INSERT ---

    def test_g2_service_role_insert(self):
        """service_role: INSERT 3 rows via SDK."""
        assert _state.ref and _state.service_role_key, "No project or keys"

        sr = self._make_sr_client()
        resp = sr.table(self.TABLE).insert([
            {"title": "Buy milk", "done": False},
            {"title": "Write tests", "done": True},
            {"title": "Deploy app", "done": False},
        ]).execute()

        assert resp.data is not None
        assert len(resp.data) == 3

        titles = [r["title"] for r in resp.data]
        assert titles == ["Buy milk", "Write tests", "Deploy app"]
        assert resp.data[1]["done"] is True

        print(f"\n  SDK INSERT 3 rows: {titles}")
        for r in resp.data:
            print(f"    id={r['id']}: {r['title']} (done={r['done']})")

    # --- g3: service_role SELECT ---

    def test_g3_service_role_select(self):
        """service_role: SELECT all rows with ordering and filtering via SDK."""
        assert _state.ref and _state.service_role_key, "No project or keys"

        sr = self._make_sr_client()

        # Select all
        resp = sr.table(self.TABLE).select("*").order("id").execute()
        assert resp.data is not None
        assert len(resp.data) == 3
        for row in resp.data:
            assert "id" in row
            assert "title" in row
            assert "done" in row
            assert "created_at" in row
        print(f"\n  SDK SELECT * => {len(resp.data)} rows")

        # Filter: done=false
        filtered = sr.table(self.TABLE).select("title, done").eq("done", "false").order("id").execute()
        assert filtered.data is not None
        assert len(filtered.data) == 2
        assert all(r["done"] is False for r in filtered.data)
        print(f"  SDK SELECT WHERE done=false => {[r['title'] for r in filtered.data]}")

        # Limit + single column
        limited = sr.table(self.TABLE).select("title").order("id").limit(1).execute()
        assert limited.data is not None
        assert len(limited.data) == 1
        assert limited.data[0]["title"] == "Buy milk"
        print(f"  SDK SELECT LIMIT 1 => {limited.data[0]}")

    # --- g3b: service_role SELECT desc order + limit ---

    def test_g3b_select_order_desc_limit(self):
        """service_role: SELECT with descending order + limit for pagination."""
        assert _state.ref and _state.service_role_key, "No project or keys"

        sr = self._make_sr_client()
        resp = sr.table(self.TABLE).select("title, id").order("id", desc=True).limit(2).execute()

        assert resp.data is not None
        assert len(resp.data) == 2, f"Expected 2 rows, got {len(resp.data)}"
        assert resp.data[0]["id"] > resp.data[1]["id"], (
            f"Not descending: {resp.data[0]['id']} vs {resp.data[1]['id']}"
        )
        print(f"\n  SDK SELECT order=id.desc limit=2 => {[r['title'] for r in resp.data]}")

    # --- g4: anon SELECT ---

    def test_g4_anon_select(self):
        """anon: SELECT should return all rows (RLS policy allows read)."""
        assert _state.ref and _state.anon_key, "No project or keys"

        anon = self._make_anon_client()
        resp = anon.table(self.TABLE).select("*").order("id").execute()

        assert resp.data is not None
        assert len(resp.data) == 3

        titles = [r["title"] for r in resp.data]
        assert "Buy milk" in titles
        assert "Write tests" in titles
        assert "Deploy app" in titles
        print(f"\n  anon SELECT => {len(resp.data)} rows: {titles}")

    # --- g5: anon INSERT denied ---

    def test_g5_anon_insert_denied(self):
        """anon: INSERT should be denied by RLS (no INSERT policy for anon)."""
        assert _state.ref and _state.anon_key, "No project or keys"

        anon = self._make_anon_client()
        try:
            anon.table(self.TABLE).insert({"title": "Hack attempt"}).execute()
            pytest.fail("anon INSERT should have been denied by RLS")
        except Exception as e:
            error_str = str(e)
            print(f"\n  anon INSERT correctly denied: {error_str[:120]}")

    # --- g6: service_role UPDATE ---

    def test_g6_service_role_update(self):
        """service_role: UPDATE rows via SDK and verify."""
        assert _state.ref and _state.service_role_key, "No project or keys"

        sr = self._make_sr_client()

        # Update single row
        resp = sr.table(self.TABLE).update({"done": True}).eq("title", "Buy milk").execute()
        assert resp.data is not None
        assert len(resp.data) == 1
        assert resp.data[0]["done"] is True
        print(f"\n  SDK UPDATE 'Buy milk' done=True")

        # Verify
        verify = sr.table(self.TABLE).select("title, done").eq("title", "Buy milk").execute()
        assert verify.data[0]["done"] is True
        print(f"  Verified: {verify.data[0]}")

        # Update multiple rows
        resp2 = sr.table(self.TABLE).update({"done": True}).eq("done", "false").execute()
        assert resp2.data is not None
        print(f"  SDK UPDATE all done=false => done=true: {len(resp2.data)} rows updated")

        # Verify all done
        all_rows = sr.table(self.TABLE).select("title, done").order("id").execute()
        assert all(r["done"] is True for r in all_rows.data)
        print(f"  All rows done=True: {[r['title'] for r in all_rows.data]}")

    # --- g7: service_role DELETE ---

    def test_g7_service_role_delete(self):
        """service_role: DELETE rows via SDK and verify count."""
        assert _state.ref and _state.service_role_key, "No project or keys"

        sr = self._make_sr_client()

        # Delete single row
        resp = sr.table(self.TABLE).delete().eq("title", "Deploy app").execute()
        assert resp.data is not None
        assert len(resp.data) == 1
        assert resp.data[0]["title"] == "Deploy app"
        print(f"\n  SDK DELETE 'Deploy app'")

        # Verify count
        remaining = sr.table(self.TABLE).select("title").order("id").execute()
        assert len(remaining.data) == 2
        titles = [r["title"] for r in remaining.data]
        assert "Deploy app" not in titles
        print(f"  Remaining: {titles}")

        # Delete another
        sr.table(self.TABLE).delete().eq("title", "Write tests").execute()
        final = sr.table(self.TABLE).select("title").execute()
        assert len(final.data) == 1
        assert final.data[0]["title"] == "Buy milk"
        print(f"  After second delete: {[r['title'] for r in final.data]}")

    # --- g8: Upsert ---

    def test_g8_upsert(self):
        """service_role: upsert — insert new record + update existing via conflict."""
        assert _state.ref and _state.service_role_key, "No project or keys"

        sr = self._make_sr_client()

        # scenario a: upsert inserts a new row (id does not exist)
        new_row = {"title": "Upsert new", "done": False}
        resp = sr.table(self.TABLE).upsert(new_row).execute()
        assert resp.data, f"Upsert insert failed: {resp}"
        upserted_id = resp.data[0]["id"]
        print(f"\n  Upserted new row id={upserted_id}")

        # scenario b: upsert updates existing row (id exists → overwrite done=True)
        updated = {"id": upserted_id, "title": "Upsert updated", "done": True}
        resp2 = sr.table(self.TABLE).upsert(updated).execute()
        assert resp2.data, f"Upsert update failed: {resp2}"
        assert resp2.data[0]["done"] is True, "Upsert did not update done field"
        print(f"  Upserted existing row: done={resp2.data[0]['done']}")

    # --- g9: Cleanup ---

    def test_g9_cleanup(self):
        """Drop test table via Studio API."""
        assert _state.ref, "No project ref"

        self._query(f"DROP TABLE IF EXISTS {self.TABLE} CASCADE;")
        self._query("NOTIFY pgrst, 'reload schema';")
        print(f"\n  Dropped {self.TABLE}")


# ============================================
# E: Secrets (NOT YET IMPLEMENTED)
# ============================================

class TestE_Secrets:
    """E: POST /api/v1/projects/{ref}/secrets — configure env vars.

    NOTE: This endpoint is not yet implemented in app/supabase/.
    The secrets.ts handler exists in app/studio/ but depends on
    lib/self-hosted-api which has not been ported.

    These tests are skipped until the endpoint is available.
    Remove the skip markers once the secrets endpoint is deployed.
    """

    def test_e1_set_secrets(self):
        """POST secrets to a project."""
        assert _state.ref, "No project ref"

        status, body = api_request(
            "POST", f"/api/v1/projects/{_state.ref}/secrets",
            body=[
                {"name": "TEST_SECRET_A", "value": "value_a"},
                {"name": "TEST_SECRET_B", "value": "value_b"},
            ],
        )
        if status == 404:
            pytest.skip("Secrets endpoint not yet implemented (404)")

        assert status == 201, f"Set secrets failed: {status} {body}"
        assert isinstance(body, list)
        names = [s["name"] for s in body]
        assert "TEST_SECRET_A" in names
        assert "TEST_SECRET_B" in names
        print(f"\n  Set {len(body)} secrets: {names}")

    def test_e2_get_secrets(self):
        """GET secrets — should return names + digest, not raw values."""
        assert _state.ref, "No project ref"

        status, body = api_request(
            "GET", f"/api/v1/projects/{_state.ref}/secrets",
        )
        if status == 404:
            pytest.skip("Secrets endpoint not yet implemented (404)")

        assert status == 200, f"Get secrets failed: {status} {body}"
        assert isinstance(body, list)

        for secret in body:
            assert "name" in secret
            assert "value" in secret  # This is actually a SHA256 digest
            # Value should be a hex digest, not the raw secret
            assert secret["value"] != "value_a", "Raw secret value should not be returned"

        print(f"\n  Retrieved {len(body)} secrets (digest only)")

    def test_e3_delete_secrets(self):
        """DELETE specific secrets."""
        assert _state.ref, "No project ref"

        status, body = api_request(
            "DELETE", f"/api/v1/projects/{_state.ref}/secrets",
            body=["TEST_SECRET_A", "TEST_SECRET_B"],
        )
        if status == 404:
            pytest.skip("Secrets endpoint not yet implemented (404)")

        assert status == 200, f"Delete secrets failed: {status} {body}"

        # Verify deleted secrets are gone
        _, remaining = api_request(
            "GET", f"/api/v1/projects/{_state.ref}/secrets", expected_status=200
        )
        remaining_names = [s["name"] for s in remaining]
        assert "TEST_SECRET_A" not in remaining_names
        assert "TEST_SECRET_B" not in remaining_names
        print(f"\n  Secrets deleted, remaining: {remaining_names}")


# ============================================
# H: Invalid API Key rejection
# ============================================

class TestH_InvalidAPIKey:
    """H: Verify Kong rejects requests with invalid API keys.

    Tests the authentication boundary (Kong key-auth plugin):
      h1: Completely random key → 401
      h2: Correct format but wrong content (sb_publishable_xxx) → 401
      h3: Empty API key → 401
      h4: No API key at all → 401

    Requires TestA (project creation) to have run (needs valid project subdomain).
    """

    def _sdk_request(self, url: str, api_key: str, path: str = "/rest/v1/") -> tuple[int, Any]:
        """Send a raw HTTP request through Kong with given API key."""
        full_url = f"{url}{path}"
        headers = {}
        if api_key is not None:
            headers["apikey"] = api_key
            headers["Authorization"] = f"Bearer {api_key}"
        req = urllib.request.Request(full_url, headers=headers, method="GET")
        try:
            resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
            status = resp.status
            raw = resp.read().decode()
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                body = {"raw": raw}
        except urllib.error.HTTPError as e:
            status = e.code
            raw = e.read().decode()
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                body = {"raw": raw}
        return status, body

    def _project_url(self):
        return f"https://{_state.ref}.{SUPABASE_DOMAIN}"

    def test_h1_random_key_rejected(self):
        """Completely random API key should be rejected with 401."""
        assert _state.ref, "No project ref (TestA must run first)"

        status, body = self._sdk_request(
            self._project_url(),
            api_key="totally-fake-random-key-12345",
        )
        assert status == 401, f"Expected 401, got {status}: {body}"
        print(f"\n  Random key => {status}: {body}")

    def test_h2_fake_opaque_key_rejected(self):
        """Correctly formatted but invalid opaque key should be rejected with 401."""
        assert _state.ref, "No project ref"

        status, body = self._sdk_request(
            self._project_url(),
            api_key="sb_publishable_AAAABBBBCCCCDDDDeeeeffffgggg1234567890",
        )
        assert status == 401, f"Expected 401, got {status}: {body}"
        print(f"\n  Fake opaque key => {status}: {body}")

    def test_h3_empty_key_rejected(self):
        """Empty string API key should be rejected with 401."""
        assert _state.ref, "No project ref"

        status, body = self._sdk_request(
            self._project_url(),
            api_key="",
        )
        assert status == 401, f"Expected 401, got {status}: {body}"
        print(f"\n  Empty key => {status}: {body}")

    def test_h4_no_key_rejected(self):
        """Request without any API key should be rejected with 401."""
        assert _state.ref, "No project ref"

        status, body = self._sdk_request(
            self._project_url(),
            api_key=None,
        )
        assert status == 401, f"Expected 401, got {status}: {body}"
        print(f"\n  No key => {status}: {body}")


# ============================================
# I: REST Direct API (like filter + PATCH)
# ============================================

class TestI_RestDirectAPI:
    """I: Direct PostgREST HTTP calls — full REST API coverage.

    Validates raw HTTP access to PostgREST endpoints without the SDK:
      i1:  Setup — create table and insert rows via Studio API
      i2:  GET all — full table scan without filters
      i3:  POST insert — insert a row via REST
      i4:  GET eq filter — precise match by id
      i5:  GET like filter — pattern match on message
      i6:  GET order + limit — sort descending with pagination
      i7:  PATCH update — partial update by id
      i8:  DELETE — remove a row by id
      i9:  anon write rejected — anon key POST should return 401/403
      i10: Cleanup — drop table via Studio API

    Requires TestA (project creation) + TestB (API keys) to run first.
    """

    TABLE = "_test_rest_direct"
    _inserted_id = None  # shared across tests via class attribute

    def _query(self, sql, expected_status=200):
        return api_request(
            "POST", f"/api/v1/projects/{_state.ref}/database/query",
            body={"query": sql},
            expected_status=expected_status,
        )

    def _rest_url(self, table: str) -> str:
        return f"https://{_state.ref}.{SUPABASE_DOMAIN}/rest/v1/{table}"

    def _rest_request(
        self,
        method: str,
        table: str,
        query_params: str = "",
        body: Any = None,
        api_key: Optional[str] = None,
    ) -> tuple[int, Any]:
        """Send a raw HTTP request directly to PostgREST."""
        url = self._rest_url(table)
        if query_params:
            url = f"{url}?{query_params}"

        key = api_key or _state.service_role_key
        headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
            status = resp.status
            raw = resp.read().decode()
            try:
                resp_body = json.loads(raw)
            except json.JSONDecodeError:
                resp_body = {"raw": raw}
        except urllib.error.HTTPError as e:
            status = e.code
            raw = e.read().decode()
            try:
                resp_body = json.loads(raw)
            except json.JSONDecodeError:
                resp_body = {"raw": raw}
        return status, resp_body

    # --- i1: Setup ---

    def test_i1_setup(self):
        """Create table and insert test rows via Studio API."""
        assert _state.ref, "No project ref (TestA must run first)"
        assert _state.anon_key and _state.service_role_key, "No keys (TestB must run first)"

        self._query(f"DROP TABLE IF EXISTS {self.TABLE} CASCADE;")
        self._query(f"""
            CREATE TABLE {self.TABLE} (
                id      BIGSERIAL PRIMARY KEY,
                message TEXT NOT NULL,
                level   TEXT NOT NULL DEFAULT 'info'
            );
        """)
        self._query(f"""
            GRANT ALL ON {self.TABLE} TO service_role;
            GRANT SELECT ON {self.TABLE} TO anon;
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, service_role;
        """)
        self._query(f"""
            ALTER TABLE {self.TABLE} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE {self.TABLE} FORCE ROW LEVEL SECURITY;
        """)
        self._query(f"""
            CREATE POLICY "anon_read" ON {self.TABLE}
                FOR SELECT TO anon USING (true);
        """)
        self._query(f"""
            CREATE POLICY "sr_all" ON {self.TABLE}
                FOR ALL TO service_role USING (true) WITH CHECK (true);
        """)
        self._query(f"""
            INSERT INTO {self.TABLE} (message, level) VALUES
                ('REST API info message', 'info'),
                ('REST API warn message', 'warn'),
                ('Other log entry', 'info');
        """)
        self._query("NOTIFY pgrst, 'reload schema';")
        time.sleep(3)

        attempts = _wait_for_schema_ready(self.TABLE, _state.service_role_key)
        print(f"\n  Table {self.TABLE} created with 3 rows (schema ready after {attempts} attempt(s))")

    # --- i2: GET all ---

    def test_i2_get_all(self):
        """GET full table without filters."""
        assert _state.ref and _state.service_role_key, "No project or keys"

        status, body = self._rest_request("GET", self.TABLE)
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert isinstance(body, list), f"Expected list, got: {body}"
        assert len(body) == 3, f"Expected 3 rows, got {len(body)}: {body}"
        print(f"\n  GET all => {len(body)} rows")
        for r in body:
            print(f"    id={r['id']}: {r['message']} ({r['level']})")

    # --- i3: POST insert ---

    def test_i3_post_insert(self):
        """POST to insert a new row via REST."""
        assert _state.ref and _state.service_role_key, "No project or keys"

        status, body = self._rest_request(
            "POST", self.TABLE,
            body={"message": "Direct POST insert test", "level": "debug"},
        )
        assert status == 201, f"Expected 201, got {status}: {body}"
        assert isinstance(body, list) and len(body) == 1, f"Unexpected response: {body}"
        TestI_RestDirectAPI._inserted_id = body[0]["id"]
        assert body[0]["message"] == "Direct POST insert test"
        assert body[0]["level"] == "debug"
        print(f"\n  POST insert => id={body[0]['id']}: {body[0]['message']}")

    # --- i4: GET eq filter ---

    def test_i4_get_eq_filter(self):
        """GET with eq filter to find a specific row by id."""
        assert _state.ref and _state.service_role_key, "No project or keys"
        assert TestI_RestDirectAPI._inserted_id, "No inserted id from i3"

        target_id = TestI_RestDirectAPI._inserted_id
        status, body = self._rest_request(
            "GET", self.TABLE,
            query_params=f"id=eq.{target_id}",
        )
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert isinstance(body, list) and len(body) == 1, f"Expected 1 row, got: {body}"
        assert body[0]["id"] == target_id
        assert body[0]["message"] == "Direct POST insert test"
        print(f"\n  GET eq filter id={target_id} => {body[0]['message']}")

    # --- i5: GET like filter ---

    def test_i5_like_filter(self):
        """GET rows where message matches like.*REST* via direct PostgREST call."""
        assert _state.ref and _state.service_role_key, "No project or keys"

        status, body = self._rest_request(
            "GET", self.TABLE,
            query_params="message=like.*REST*",
        )
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert isinstance(body, list), f"Expected list, got: {body}"
        assert len(body) == 2, f"Expected 2 rows matching 'REST', got {len(body)}: {body}"
        messages = [r["message"] for r in body]
        assert all("REST" in m for m in messages), f"Unexpected messages: {messages}"
        print(f"\n  like filter => {len(body)} rows: {messages}")

    # --- i6: GET order + limit ---

    def test_i6_get_order_limit(self):
        """GET with order=id.desc&limit=2 for sort + pagination."""
        assert _state.ref and _state.service_role_key, "No project or keys"

        status, body = self._rest_request(
            "GET", self.TABLE,
            query_params="order=id.desc&limit=2",
        )
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert isinstance(body, list), f"Expected list, got: {body}"
        assert len(body) == 2, f"Expected 2 rows, got {len(body)}: {body}"
        assert body[0]["id"] > body[1]["id"], (
            f"Not descending: id {body[0]['id']} vs {body[1]['id']}"
        )
        print(f"\n  GET order=id.desc limit=2 => ids: {[r['id'] for r in body]}")

    # --- i7: PATCH update ---

    def test_i7_patch_update(self):
        """PATCH a single row by id to change its level field."""
        assert _state.ref and _state.service_role_key, "No project or keys"

        # Fetch the warn row to get its id
        status, rows = self._rest_request(
            "GET", self.TABLE,
            query_params="level=eq.warn",
        )
        assert status == 200 and rows, f"Could not fetch warn row: {status} {rows}"
        target_id = rows[0]["id"]

        # PATCH level to 'error'
        status, body = self._rest_request(
            "PATCH", self.TABLE,
            query_params=f"id=eq.{target_id}",
            body={"level": "error"},
        )
        assert status == 200, f"PATCH failed: {status}: {body}"
        assert isinstance(body, list) and len(body) == 1, f"Expected 1 updated row: {body}"
        assert body[0]["level"] == "error", f"level not updated: {body[0]}"
        print(f"\n  PATCH id={target_id}: level => {body[0]['level']}")

    # --- i8: DELETE ---

    def test_i8_delete(self):
        """DELETE a specific row by id."""
        assert _state.ref and _state.service_role_key, "No project or keys"
        assert TestI_RestDirectAPI._inserted_id, "No inserted id from i3"

        target_id = TestI_RestDirectAPI._inserted_id
        status, body = self._rest_request(
            "DELETE", self.TABLE,
            query_params=f"id=eq.{target_id}",
        )
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert isinstance(body, list) and len(body) == 1, f"Expected 1 deleted row: {body}"
        assert body[0]["id"] == target_id
        print(f"\n  DELETE id={target_id} => removed '{body[0]['message']}'")

        # Verify row is gone
        status, verify = self._rest_request(
            "GET", self.TABLE,
            query_params=f"id=eq.{target_id}",
        )
        assert status == 200 and len(verify) == 0, f"Row still exists: {verify}"
        print(f"  Verified: row id={target_id} no longer exists")

    # --- i9: anon write rejected ---

    def test_i9_anon_write_rejected(self):
        """anon key POST to insert a row should be rejected with 401 or 403."""
        assert _state.ref and _state.anon_key, "No project or anon key"

        status, body = self._rest_request(
            "POST", self.TABLE,
            body={"message": "anon should not write", "level": "info"},
            api_key=_state.anon_key,
        )
        assert status in (401, 403), f"Expected 401/403 for anon write, got {status}: {body}"
        print(f"\n  anon POST => {status} (write correctly rejected)")

    # --- i10: Cleanup ---

    def test_i10_cleanup(self):
        """Drop test table via Studio API."""
        assert _state.ref, "No project ref"

        self._query(f"DROP TABLE IF EXISTS {self.TABLE} CASCADE;")
        self._query("NOTIFY pgrst, 'reload schema';")
        print(f"\n  Dropped {self.TABLE}")
