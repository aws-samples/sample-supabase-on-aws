"""
Authenticated User RLS integration tests.

Tests that GoTrue access_tokens are correctly passed through Kong's
dynamic-lambda-router to PostgREST, enabling RLS policies based on
auth.uid() and auth.role() = 'authenticated'.

Flow:
  A: Setup — fetch opaque API keys, create table with authenticated RLS policy (2 tests)
  B: Signup & Login — create user via GoTrue, get access_token (2 tests)
  C: Authenticated CRUD — use access_token for RLS-protected operations (4 tests)
  D: Security — tampered JWT, cross-user UPDATE/DELETE blocked (4 tests)
  E: Cleanup (1 test)

Usage:
  cd tests
  ./RUN_TESTS.sh auth-rls

  # Or with manual config:
  PROJECT_REF=<ref> python3 -m pytest test_authenticated_rls.py -v -s
"""

import base64
import hashlib
import hmac
import json
import os
import ssl
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Optional

import pytest

from config import BASE_DOMAIN, TIMEOUTS

# ============================================
# Configuration
# ============================================

STUDIO_ALB = os.getenv("STUDIO_ALB", "")
_INITIAL_PROJECT_REF = os.getenv("PROJECT_REF") or ""

# Unique test user per run
TEST_EMAIL = f"auth-rls-{uuid.uuid4().hex[:8]}@example.com"
TEST_PASSWORD = "AuthRLStest123!"

# Second user for cross-user RLS testing
TEST_EMAIL_2 = f"auth-rls-{uuid.uuid4().hex[:8]}@example.com"
TEST_PASSWORD_2 = "AuthRLStest456!"

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

TIMEOUT = TIMEOUTS.get("read", 30)

TABLE_NAME = "_test_auth_rls"


# ============================================
# HTTP helpers
# ============================================

def studio_api_request(method: str, path: str, body: Any = None, timeout: int = TIMEOUT) -> tuple[int, Any]:
    """Send a request to Studio API and return (status_code, parsed_json)."""
    url = f"https://{STUDIO_ALB}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=timeout)
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


def auth_request(
    method: str,
    path: str,
    data: Optional[dict] = None,
    access_token: Optional[str] = None,
    expected_status: Optional[int] = 200,
) -> dict:
    """Make an HTTP request to the auth service through Kong."""
    url = f"https://{_st.project_ref}.{BASE_DOMAIN}/auth/v1{path}"

    req_headers = {
        "Content-Type": "application/json",
        "apikey": _st.anon_key,
        "X-Tenant-Id": _st.project_ref,
    }
    if access_token:
        req_headers["Authorization"] = f"Bearer {access_token}"

    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=req_headers, method=method)

    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT, context=SSL_CTX)
        status = resp.status
        resp_body = resp.read().decode()
    except urllib.error.HTTPError as e:
        status = e.code
        resp_body = e.read().decode()

    if expected_status is not None and status != expected_status:
        raise AssertionError(
            f"Expected status {expected_status}, got {status}\n"
            f"URL: {method} {url}\n"
            f"Response: {resp_body[:500]}"
        )

    try:
        return json.loads(resp_body) if resp_body.strip() else {}
    except json.JSONDecodeError:
        return {"_raw": resp_body, "_status": status}


def rest_request(
    method: str,
    path: str,
    body: Any = None,
    api_key: str = "",
    access_token: Optional[str] = None,
    expected_status: Optional[int] = None,
    extra_headers: Optional[dict] = None,
) -> tuple[int, Any]:
    """Make a raw HTTP request to the REST API through Kong."""
    url = f"https://{_st.project_ref}.{BASE_DOMAIN}/rest/v1{path}"

    req_headers = {
        "Content-Type": "application/json",
        "apikey": api_key or _st.anon_key,
        "Prefer": "return=representation",
    }
    if access_token:
        req_headers["Authorization"] = f"Bearer {access_token}"
    if extra_headers:
        req_headers.update(extra_headers)

    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)

    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT, context=SSL_CTX)
        status = resp.status
        raw = resp.read().decode()
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read().decode()

    try:
        resp_body = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        resp_body = {"_raw": raw}

    if expected_status is not None and status != expected_status:
        raise AssertionError(
            f"Expected status {expected_status}, got {status}\n"
            f"URL: {method} {url}\n"
            f"Response: {str(resp_body)[:500]}"
        )

    return status, resp_body


def _query(sql: str, expected_status: int = 200) -> tuple[int, Any]:
    """Execute SQL via Studio API query endpoint."""
    return studio_api_request(
        "POST", f"/api/v1/projects/{_st.project_ref}/database/query",
        body={"query": sql},
    )


def _wait_for_schema_ready(table: str, api_key: str, max_attempts: int = 8):
    """Wait until PostgREST Lambda picks up a newly created table.

    In Lambda, PostgREST LISTEN/NOTIFY has a race condition during
    freeze/unfreeze cycles. This helper pings the REST root to unfreeze
    the Lambda, re-sends NOTIFY, and retries until the schema is loaded.
    """
    rest_base = f"https://{_st.project_ref}.{BASE_DOMAIN}/rest/v1"
    headers = {"apikey": api_key, "Authorization": f"Bearer {api_key}"}

    # Ping root to unfreeze Lambda
    req = urllib.request.Request(f"{rest_base}/", headers=headers, method="GET")
    try:
        urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
    except Exception:
        pass

    # Re-send NOTIFY now that Lambda is awake
    _query("NOTIFY pgrst, 'reload schema';")
    time.sleep(5)

    for attempt in range(max_attempts):
        url = f"{rest_base}/{table}?limit=1"
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
            if resp.status == 200:
                return
        except urllib.error.HTTPError:
            pass
        _query("NOTIFY pgrst, 'reload schema';")
        time.sleep(3)

    raise AssertionError(
        f"PostgREST did not pick up table {table} after {max_attempts} retries"
    )


# ============================================
# Shared state
# ============================================

class _State:
    project_ref: str = ""
    anon_key: str = ""
    service_role_key: str = ""
    # User 1
    user1_id: str = ""
    user1_email: str = TEST_EMAIL
    user1_access_token: str = ""
    # User 2
    user2_id: str = ""
    user2_email: str = TEST_EMAIL_2
    user2_access_token: str = ""


_st = _State()

if _INITIAL_PROJECT_REF:
    _st.project_ref = _INITIAL_PROJECT_REF
_env_anon = os.getenv("SUPABASE_ANON_KEY") or ""
if _env_anon.startswith("sb_"):
    _st.anon_key = _env_anon
_env_sr = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
if _env_sr.startswith("sb_"):
    _st.service_role_key = _env_sr


# ============================================
# Test A: Setup (2 tests)
# ============================================

class TestA_Setup:
    """Resolve project, fetch keys, create table with authenticated RLS policy."""

    def test_a1_fetch_keys(self):
        """Resolve project and fetch opaque API keys from Studio API."""
        if _st.anon_key and _st.service_role_key and _st.project_ref:
            print(f"\n  Using pre-configured project={_st.project_ref}")
            return

        assert STUDIO_ALB, (
            "STUDIO_ALB not set. Run via ./RUN_TESTS.sh auth-rls or set STUDIO_ALB manually."
        )

        # Auto-select project if not provided
        if not _st.project_ref:
            status, projects = studio_api_request("GET", "/api/v1/projects")
            assert status == 200 and isinstance(projects, list) and len(projects) > 0, (
                f"No projects found: {status} {projects}"
            )
            _st.project_ref = projects[0]["ref"]
            print(f"\n  Auto-selected project: {_st.project_ref}")

        # Fetch API keys
        status, body = studio_api_request(
            "GET", f"/api/v1/projects/{_st.project_ref}/api-keys"
        )
        assert status == 200 and isinstance(body, list) and len(body) >= 2

        anon = next((k for k in body if k["name"] == "anon"), None)
        sr = next((k for k in body if k["name"] == "service_role"), None)
        assert anon and sr

        _st.anon_key = anon["api_key"]
        _st.service_role_key = sr["api_key"]
        print(f"  Project: {_st.project_ref}")
        print(f"  anon_key: {_st.anon_key[:40]}...")
        print(f"  service_role_key: {_st.service_role_key[:40]}...")

    def test_a2_create_table_with_authenticated_rls(self):
        """Create table with RLS policy requiring auth.uid()."""
        assert _st.project_ref, "No project ref"

        # Drop if leftover
        _query(f"DROP TABLE IF EXISTS {TABLE_NAME} CASCADE;")

        # Create table with user_id column for RLS
        _query(f"""
            CREATE TABLE {TABLE_NAME} (
                id         SERIAL PRIMARY KEY,
                user_id    UUID NOT NULL,
                title      TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        """)

        # Grant permissions
        _query(f"""
            GRANT ALL ON {TABLE_NAME} TO service_role;
            GRANT ALL ON {TABLE_NAME} TO authenticated;
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
        """)

        # Enable RLS
        _query(f"""
            ALTER TABLE {TABLE_NAME} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE {TABLE_NAME} FORCE ROW LEVEL SECURITY;
        """)

        # RLS: authenticated users can only see/modify their own rows
        _query(f"""
            CREATE POLICY "auth_own_rows" ON {TABLE_NAME}
                FOR ALL TO authenticated
                USING (user_id = auth.uid())
                WITH CHECK (user_id = auth.uid());
        """)

        # RLS: service_role has full access (BYPASSRLS, but explicit policy for clarity)
        _query(f"""
            CREATE POLICY "sr_all" ON {TABLE_NAME}
                FOR ALL TO service_role
                USING (true) WITH CHECK (true);
        """)

        # No policy for anon — anon cannot see anything
        _query("NOTIFY pgrst, 'reload schema';")
        time.sleep(3)

        # Schema cache warmup for Lambda PostgREST
        _wait_for_schema_ready(TABLE_NAME, _st.service_role_key)
        print(f"\n  Table {TABLE_NAME} created with authenticated RLS")
        print(f"    authenticated: own rows only (user_id = auth.uid())")
        print(f"    anon: no access")
        print(f"    service_role: full access")


# ============================================
# Test B: Signup & Login (2 tests)
# ============================================

class TestB_Auth:
    """Create two users via GoTrue and get access tokens."""

    def test_b1_signup_and_login_user1(self):
        """Signup + login user1 via GoTrue."""
        assert _st.project_ref and _st.anon_key

        # Signup
        resp = auth_request("POST", "/signup", data={
            "email": _st.user1_email,
            "password": TEST_PASSWORD,
        })

        if "id" in resp:
            _st.user1_id = resp["id"]
        elif "user" in resp and resp["user"]:
            _st.user1_id = resp["user"]["id"]

        # If autoconfirm, may already have token
        if "access_token" in resp:
            _st.user1_access_token = resp["access_token"]

        # Login to ensure we have a fresh token
        resp = auth_request("POST", "/token?grant_type=password", data={
            "email": _st.user1_email,
            "password": TEST_PASSWORD,
        })
        assert "access_token" in resp, f"Login failed: {resp}"
        _st.user1_access_token = resp["access_token"]
        _st.user1_id = resp.get("user", {}).get("id", _st.user1_id)

        assert _st.user1_id, "No user ID obtained"
        print(f"\n  User1: {_st.user1_email}")
        print(f"  User1 ID: {_st.user1_id}")
        print(f"  Access token: {_st.user1_access_token[:50]}...")

    def test_b2_signup_and_login_user2(self):
        """Signup + login user2 via GoTrue."""
        assert _st.project_ref and _st.anon_key

        resp = auth_request("POST", "/signup", data={
            "email": _st.user2_email,
            "password": TEST_PASSWORD_2,
        })

        if "id" in resp:
            _st.user2_id = resp["id"]
        elif "user" in resp and resp["user"]:
            _st.user2_id = resp["user"]["id"]

        resp = auth_request("POST", "/token?grant_type=password", data={
            "email": _st.user2_email,
            "password": TEST_PASSWORD_2,
        })
        assert "access_token" in resp, f"Login failed: {resp}"
        _st.user2_access_token = resp["access_token"]
        _st.user2_id = resp.get("user", {}).get("id", _st.user2_id)

        assert _st.user2_id, "No user ID obtained"
        print(f"\n  User2: {_st.user2_email}")
        print(f"  User2 ID: {_st.user2_id}")


# ============================================
# Test C: Authenticated CRUD (4 tests)
# ============================================

class TestC_AuthenticatedCRUD:
    """Test RLS enforcement with authenticated user access tokens."""

    def test_c1_service_role_seed_data(self):
        """Seed data for both users via service_role (bypasses RLS)."""
        assert _st.service_role_key and _st.user1_id and _st.user2_id

        # Insert rows for user1
        status, body = rest_request(
            "POST", f"/{TABLE_NAME}",
            body=[
                {"user_id": _st.user1_id, "title": "User1 Task A"},
                {"user_id": _st.user1_id, "title": "User1 Task B"},
            ],
            api_key=_st.service_role_key,
            expected_status=201,
        )
        assert len(body) == 2
        print(f"\n  Seeded 2 rows for user1: {[r['title'] for r in body]}")

        # Insert rows for user2
        status, body = rest_request(
            "POST", f"/{TABLE_NAME}",
            body=[
                {"user_id": _st.user2_id, "title": "User2 Task X"},
            ],
            api_key=_st.service_role_key,
            expected_status=201,
        )
        assert len(body) == 1
        print(f"  Seeded 1 row for user2: {[r['title'] for r in body]}")

    def test_c2_authenticated_select_own_rows(self):
        """Authenticated user1 SELECT should only return own rows (core RLS test)."""
        assert _st.user1_access_token

        status, body = rest_request(
            "GET", f"/{TABLE_NAME}?select=*&order=id",
            api_key=_st.anon_key,
            access_token=_st.user1_access_token,
            expected_status=200,
        )
        assert isinstance(body, list), f"Expected array, got: {type(body)}"
        assert len(body) == 2, f"User1 should see 2 rows, got {len(body)}: {body}"

        titles = [r["title"] for r in body]
        assert "User1 Task A" in titles
        assert "User1 Task B" in titles
        assert "User2 Task X" not in titles, "User1 should NOT see user2's rows"

        for row in body:
            assert row["user_id"] == _st.user1_id, f"Row user_id mismatch: {row}"

        print(f"\n  User1 authenticated SELECT => {len(body)} rows: {titles}")
        print(f"  RLS correctly filtered: user2's rows NOT visible")

    def test_c3_authenticated_insert_own_row(self):
        """Authenticated user1 INSERT with own user_id should succeed."""
        assert _st.user1_access_token

        status, body = rest_request(
            "POST", f"/{TABLE_NAME}",
            body={"user_id": _st.user1_id, "title": "User1 Task C (via auth)"},
            api_key=_st.anon_key,
            access_token=_st.user1_access_token,
            expected_status=201,
        )
        assert isinstance(body, list) and len(body) == 1
        assert body[0]["title"] == "User1 Task C (via auth)"
        assert body[0]["user_id"] == _st.user1_id
        print(f"\n  User1 authenticated INSERT => {body[0]['title']}")

    def test_c4_anon_select_sees_nothing(self):
        """Anon SELECT (no access_token) should return empty (no anon RLS policy)."""
        status, body = rest_request(
            "GET", f"/{TABLE_NAME}?select=*",
            api_key=_st.anon_key,
            expected_status=200,
        )
        assert isinstance(body, list), f"Expected array, got: {type(body)}"
        assert len(body) == 0, f"Anon should see 0 rows, got {len(body)}: {body}"
        print(f"\n  Anon SELECT => {len(body)} rows (correctly empty)")


# ============================================
# Test D: Security (2 tests)
# ============================================

class TestD_Security:
    """Test security boundaries: tampered JWT, role escalation."""

    def test_d1_tampered_jwt_degrades_to_anon(self):
        """Tampered JWT should be rejected, request degrades to anon (sees nothing)."""
        assert _st.user1_access_token

        # Tamper with the token by modifying the signature
        parts = _st.user1_access_token.split(".")
        assert len(parts) == 3, "Invalid JWT structure"
        # Flip some bytes in the signature
        tampered_sig = parts[2][:5] + "XXXXX" + parts[2][10:]
        tampered_token = f"{parts[0]}.{parts[1]}.{tampered_sig}"

        status, body = rest_request(
            "GET", f"/{TABLE_NAME}?select=*",
            api_key=_st.anon_key,
            access_token=tampered_token,
            expected_status=200,
        )
        # Should degrade to anon and see nothing (no anon policy)
        assert isinstance(body, list), f"Expected array, got: {type(body)}"
        assert len(body) == 0, (
            f"Tampered JWT should degrade to anon (0 rows), got {len(body)}: {body}"
        )
        print(f"\n  Tampered JWT => {len(body)} rows (correctly degraded to anon)")

    def test_d2_cross_user_isolation(self):
        """User2 authenticated SELECT should only see own rows, not user1's."""
        assert _st.user2_access_token

        status, body = rest_request(
            "GET", f"/{TABLE_NAME}?select=*&order=id",
            api_key=_st.anon_key,
            access_token=_st.user2_access_token,
            expected_status=200,
        )
        assert isinstance(body, list)
        assert len(body) == 1, f"User2 should see 1 row, got {len(body)}: {body}"
        assert body[0]["title"] == "User2 Task X"
        assert body[0]["user_id"] == _st.user2_id
        print(f"\n  User2 SELECT => {len(body)} row: {body[0]['title']}")
        print(f"  Cross-user isolation confirmed: user1's rows NOT visible")

    def test_d3_cross_user_update_blocked(self):
        """User2 UPDATE on user1's row should affect 0 rows (RLS blocks)."""
        assert _st.user2_access_token and _st.user1_id

        # Get one of user1's row ids via service_role
        status, user1_rows = rest_request(
            "GET", f"/{TABLE_NAME}?user_id=eq.{_st.user1_id}&select=id,title&limit=1",
            api_key=_st.service_role_key,
            expected_status=200,
        )
        assert len(user1_rows) >= 1, f"No user1 rows found: {user1_rows}"
        target_id = user1_rows[0]["id"]
        original_title = user1_rows[0]["title"]

        # User2 tries to UPDATE user1's row
        status, body = rest_request(
            "PATCH", f"/{TABLE_NAME}?id=eq.{target_id}",
            body={"title": "HACKED BY USER2"},
            api_key=_st.anon_key,
            access_token=_st.user2_access_token,
            expected_status=200,
        )
        # RLS blocks: PATCH returns empty array (0 rows affected)
        assert isinstance(body, list)
        assert len(body) == 0, f"User2 should not update user1's row, got {len(body)}: {body}"
        print(f"\n  User2 PATCH user1's row id={target_id} => 0 rows affected (RLS blocked)")

        # Verify row unchanged via service_role
        status, verify = rest_request(
            "GET", f"/{TABLE_NAME}?id=eq.{target_id}&select=title",
            api_key=_st.service_role_key,
            expected_status=200,
        )
        assert verify[0]["title"] == original_title, (
            f"Row was modified! Expected '{original_title}', got '{verify[0]['title']}'"
        )
        print(f"  Verified: row unchanged = '{verify[0]['title']}'")

    def test_d4_cross_user_delete_blocked(self):
        """User2 DELETE on user1's rows should affect 0 rows (RLS blocks)."""
        assert _st.user2_access_token and _st.user1_id

        # Count user1's rows via service_role
        status, before = rest_request(
            "GET", f"/{TABLE_NAME}?user_id=eq.{_st.user1_id}&select=id",
            api_key=_st.service_role_key,
            expected_status=200,
        )
        count_before = len(before)
        assert count_before > 0, "No user1 rows to test deletion"

        # User2 tries to DELETE all of user1's rows
        status, body = rest_request(
            "DELETE", f"/{TABLE_NAME}?user_id=eq.{_st.user1_id}",
            api_key=_st.anon_key,
            access_token=_st.user2_access_token,
            expected_status=200,
        )
        assert isinstance(body, list)
        assert len(body) == 0, f"User2 should not delete user1's rows, got {len(body)}: {body}"
        print(f"\n  User2 DELETE user1's rows => 0 rows affected (RLS blocked)")

        # Verify rows still exist via service_role
        status, after = rest_request(
            "GET", f"/{TABLE_NAME}?user_id=eq.{_st.user1_id}&select=id",
            api_key=_st.service_role_key,
            expected_status=200,
        )
        assert len(after) == count_before, (
            f"Rows deleted! Before={count_before}, after={len(after)}"
        )
        print(f"  Verified: user1 still has {len(after)} rows")


# ============================================
# Test E: Cleanup (1 test)
# ============================================

class TestE_Cleanup:
    """Clean up test table and users."""

    def test_e1_cleanup(self):
        """Drop test table."""
        assert _st.project_ref

        _query(f"DROP TABLE IF EXISTS {TABLE_NAME} CASCADE;")
        _query("NOTIFY pgrst, 'reload schema';")
        print(f"\n  Dropped {TABLE_NAME}")
        print(f"  Test users remain in auth.users (no cleanup API available)")
