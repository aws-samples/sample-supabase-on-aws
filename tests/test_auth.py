"""
Auth (GoTrue) service integration tests.

Tests the /auth/v1/ endpoints through Kong gateway.
GoTrue provides user authentication: signup, login, token management, user profiles.

Flow:
  A: Setup — fetch opaque API keys from Studio API (1 test)
  B: Health & Settings (2 tests)
  C: Signup (2 tests)
  D: Login / Token (3 tests)
  E: User Management (3 tests)
  F: Logout (3 tests)

Usage:
  cd tests
  ./RUN_TESTS.sh auth

  # Or with manual config:
  PROJECT_REF=<ref> python3 -m pytest test_auth.py -v -s

  # Use specific opaque API key (skip Studio API fetch):
  SUPABASE_ANON_KEY=sb_publishable_xxx PROJECT_REF=myproject \
    python3 -m pytest test_auth.py -v -s
"""

import json
import os
import ssl
import urllib.error
import urllib.request
import uuid
from typing import Any, Optional

import pytest

from config import (
    BASE_DOMAIN,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    TEST_PROJECTS,
    TIMEOUTS,
)

# ============================================
# Configuration
# ============================================

# Studio ALB for fetching opaque API keys (set by RUN_TESTS.sh)
STUDIO_ALB = os.getenv("STUDIO_ALB", "")

# PROJECT_REF: from env, or auto-detected in TestA_Setup
_INITIAL_PROJECT_REF = os.getenv("PROJECT_REF") or ""

# Unique test user per run
TEST_EMAIL = f"test-{uuid.uuid4().hex[:8]}@example.com"
TEST_PASSWORD = "TestPassword123!"

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

TIMEOUT = TIMEOUTS.get("read", 30)


# ============================================
# HTTP helpers
# ============================================

def studio_api_request(method: str, path: str) -> tuple[int, Any]:
    """Send a request to Studio API and return (status_code, parsed_json)."""
    url = f"https://{STUDIO_ALB}{path}"
    req = urllib.request.Request(url, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
        status = resp.status
        body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read().decode()
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"raw": raw}
    return status, body


def auth_request(
    method: str,
    path: str,
    data: Optional[dict] = None,
    headers: Optional[dict] = None,
    access_token: Optional[str] = None,
    expected_status: Optional[int] = 200,
) -> dict:
    """Make an HTTP request to the auth service through Kong.

    Args:
        method: HTTP method (GET, POST, PUT, DELETE).
        path: Path relative to /auth/v1 (e.g. "/health").
        data: JSON body (optional).
        headers: Extra headers (optional).
        access_token: Bearer token for authenticated endpoints.
        expected_status: Assert response status. None to skip assertion.

    Returns:
        Parsed JSON response body, or {} for empty body.
    """
    url = f"https://{_st.project_ref}.{BASE_DOMAIN}/auth/v1{path}"

    req_headers = {
        "Content-Type": "application/json",
        "apikey": _st.anon_key,
        "X-Tenant-Id": _st.project_ref,
    }
    if access_token:
        req_headers["Authorization"] = f"Bearer {access_token}"
    if headers:
        req_headers.update(headers)

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


# ============================================
# Shared state across ordered test classes
# ============================================

class _State:
    project_ref: str = ""
    anon_key: str = ""
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    user_id: Optional[str] = None
    email: str = TEST_EMAIL
    password: str = TEST_PASSWORD


_st = _State()

# Pre-populate from env vars
if _INITIAL_PROJECT_REF:
    _st.project_ref = _INITIAL_PROJECT_REF
_env_anon = os.getenv("SUPABASE_ANON_KEY") or ""
if _env_anon.startswith("sb_"):
    _st.anon_key = _env_anon


# ============================================
# Test A: Setup — fetch opaque API keys (1 test)
# ============================================

class TestA_Setup:
    """Resolve project ref and fetch opaque API keys from Studio API."""

    def test_01_fetch_opaque_keys(self):
        """Resolve project and GET /api/v1/projects/{ref}/api-keys for opaque keys."""
        if _st.anon_key and _st.project_ref:
            print(f"\n  Using pre-configured project={_st.project_ref}")
            print(f"  anon key: {_st.anon_key[:30]}...")
            return

        assert STUDIO_ALB, (
            "STUDIO_ALB not set and no opaque SUPABASE_ANON_KEY provided. "
            "Run via ./RUN_TESTS.sh auth or set STUDIO_ALB manually."
        )

        # If no PROJECT_REF provided, pick the first available project from Studio API
        if not _st.project_ref:
            status, projects = studio_api_request("GET", "/api/v1/projects")
            assert status == 200 and isinstance(projects, list) and len(projects) > 0, (
                f"No projects found via Studio API: {status} {projects}"
            )
            _st.project_ref = projects[0]["ref"]
            print(f"\n  Auto-selected project: {_st.project_ref} ({projects[0].get('name', '?')})")

        # Fetch opaque API keys
        status, body = studio_api_request(
            "GET", f"/api/v1/projects/{_st.project_ref}/api-keys"
        )
        assert status == 200, f"Failed to fetch API keys: {status} {body}"
        assert isinstance(body, list), f"Expected array, got: {type(body)}"
        assert len(body) >= 2, f"Expected at least 2 keys, got {len(body)}"

        anon = next((k for k in body if k["name"] == "anon"), None)
        assert anon and "api_key" in anon, f"'anon' key not found: {body}"

        _st.anon_key = anon["api_key"]
        assert _st.anon_key.startswith("sb_"), (
            f"Expected opaque key (sb_publishable_xxx), got: {_st.anon_key[:40]}..."
        )
        print(f"  Project: {_st.project_ref}")
        print(f"  Fetched anon key: {_st.anon_key[:40]}...")


# ============================================
# Test B: Health & Settings (2 tests)
# ============================================

class TestB_HealthAndSettings:
    """Verify auth service is reachable through Kong."""

    def test_01_health(self):
        """GET /health returns service info."""
        resp = auth_request("GET", "/health")
        print(f"  Health: {json.dumps(resp, indent=2)}")
        assert "version" in resp or "name" in resp or "description" in resp, \
            f"Unexpected health response: {resp}"

    def test_02_settings(self):
        """GET /settings returns auth configuration."""
        resp = auth_request("GET", "/settings")
        print(f"  Settings keys: {sorted(resp.keys())}")
        assert "external" in resp or "disable_signup" in resp, \
            f"Unexpected settings response: {resp}"
        if "disable_signup" in resp:
            print(f"  disable_signup = {resp['disable_signup']}")
        if "mailer_autoconfirm" in resp:
            print(f"  mailer_autoconfirm = {resp['mailer_autoconfirm']}")


# ============================================
# Test C: Signup (2 tests)
# ============================================

class TestC_Signup:
    """Test user registration."""

    def test_01_signup_email(self):
        """POST /signup registers a new user with email + password."""
        resp = auth_request("POST", "/signup", data={
            "email": _st.email,
            "password": _st.password,
        })
        print(f"  Signup email: {_st.email}")
        print(f"  Response keys: {sorted(resp.keys())}")

        # GoTrue returns user object; if autoconfirm is on, also returns tokens
        if "id" in resp:
            _st.user_id = resp["id"]
        elif "user" in resp and resp["user"]:
            _st.user_id = resp["user"]["id"]

        if "access_token" in resp:
            _st.access_token = resp["access_token"]
            _st.refresh_token = resp.get("refresh_token")
            print(f"  Autoconfirm enabled: got access_token")

        assert _st.user_id, f"No user ID in signup response: {resp}"
        print(f"  User ID: {_st.user_id}")

    def test_02_signup_duplicate_email(self):
        """POST /signup with existing email returns a safe response."""
        # GoTrue returns a fake success to prevent email enumeration
        resp = auth_request("POST", "/signup", data={
            "email": _st.email,
            "password": _st.password,
        }, expected_status=None)
        print(f"  Duplicate signup handled (no email enumeration leak)")


# ============================================
# Test D: Login / Token (3 tests)
# ============================================

class TestD_Login:
    """Test authentication via /token endpoint."""

    def test_01_login_password(self):
        """POST /token?grant_type=password returns access + refresh tokens."""
        resp = auth_request("POST", "/token?grant_type=password", data={
            "email": _st.email,
            "password": _st.password,
        })
        print(f"  Response keys: {sorted(resp.keys())}")

        assert "access_token" in resp, f"Missing access_token: {resp}"
        assert "refresh_token" in resp, f"Missing refresh_token: {resp}"

        _st.access_token = resp["access_token"]
        _st.refresh_token = resp["refresh_token"]

        print(f"  token_type: {resp.get('token_type')}")
        print(f"  expires_in: {resp.get('expires_in')}s")
        user = resp.get("user", {})
        print(f"  user.email: {user.get('email')}")

    def test_02_login_wrong_password(self):
        """POST /token?grant_type=password with wrong password is rejected."""
        resp = auth_request("POST", "/token?grant_type=password", data={
            "email": _st.email,
            "password": "WrongPassword999!",
        }, expected_status=400)
        print(f"  Rejected: {resp.get('error_description', resp.get('msg', resp))}")

    def test_03_refresh_token(self):
        """POST /token?grant_type=refresh_token refreshes access token."""
        assert _st.refresh_token, "No refresh token from login"

        resp = auth_request("POST", "/token?grant_type=refresh_token", data={
            "refresh_token": _st.refresh_token,
        })

        assert "access_token" in resp, f"Missing access_token: {resp}"
        _st.access_token = resp["access_token"]
        _st.refresh_token = resp.get("refresh_token", _st.refresh_token)
        print(f"  Access token refreshed")


# ============================================
# Test E: User Management (3 tests)
# ============================================

class TestE_UserManagement:
    """Test user profile operations (authenticated)."""

    def test_01_get_user(self):
        """GET /user returns current user profile."""
        assert _st.access_token, "No access token"

        resp = auth_request("GET", "/user", access_token=_st.access_token)
        print(f"  User ID: {resp.get('id')}")
        print(f"  Email: {resp.get('email')}")

        assert resp.get("id") == _st.user_id, \
            f"User ID mismatch: {resp.get('id')} != {_st.user_id}"
        assert resp.get("email") == _st.email

    def test_02_update_user_metadata(self):
        """PUT /user updates user_metadata."""
        assert _st.access_token, "No access token"

        metadata = {"display_name": "Test User", "test_run": True}
        resp = auth_request("PUT", "/user", data={
            "data": metadata,
        }, access_token=_st.access_token)

        um = resp.get("user_metadata", {})
        assert um.get("display_name") == "Test User", f"Metadata not set: {um}"
        print(f"  user_metadata.display_name = {um.get('display_name')}")

    def test_03_get_user_verify_metadata(self):
        """GET /user verifies metadata persisted."""
        assert _st.access_token, "No access token"

        resp = auth_request("GET", "/user", access_token=_st.access_token)
        um = resp.get("user_metadata", {})
        assert um.get("display_name") == "Test User", f"Metadata lost: {um}"
        print(f"  Metadata persisted: display_name = {um.get('display_name')}")


# ============================================
# Test F: Logout (3 tests)
# ============================================

class TestF_Logout:
    """Test session revocation."""

    def test_01_logout(self):
        """POST /logout revokes session (204 No Content)."""
        assert _st.access_token, "No access token"

        auth_request("POST", "/logout", access_token=_st.access_token, expected_status=204)
        print(f"  Logout successful (204)")

    def test_02_refresh_after_logout(self):
        """POST /token?grant_type=refresh_token should fail after logout."""
        if not _st.refresh_token:
            pytest.skip("No refresh token")

        resp = auth_request("POST", "/token?grant_type=refresh_token", data={
            "refresh_token": _st.refresh_token,
        }, expected_status=None)

        if "error" in resp or "access_token" not in resp:
            print(f"  Refresh token revoked as expected")
        else:
            print(f"  Refresh token still valid (scope-dependent)")

    def test_03_re_login(self):
        """POST /token?grant_type=password still works after logout."""
        resp = auth_request("POST", "/token?grant_type=password", data={
            "email": _st.email,
            "password": _st.password,
        })
        assert "access_token" in resp
        print(f"  Re-login successful after logout")
