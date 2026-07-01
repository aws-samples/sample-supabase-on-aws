"""
Per-tenant Google OAuth end-to-end integration tests.

Covers the per-tenant OAuth provider feature (auth + tenant-manager + kong):
  - tenant-manager admin API stores/masks/deletes a project's Google provider
    config (client_id/secret encrypted at rest, secret never returned).
  - GoTrue resolves that per-tenant config and reflects it in /auth/v1/settings.
  - Kong allows the unauthenticated OAuth/SAML callback endpoints to pass through
    to GoTrue (callback/verify/sso), while still enforcing key-auth on the
    protected endpoints (e.g. /user).
  - GoTrue /authorize?provider=google starts the redirect chain using the
    tenant's own client_id.

Flow:
  O0: Setup — fetch anon key for the test project (1 test)
  O1: Provider config CRUD via tenant-manager admin API (3 tests)
  O2: GoTrue /settings reflects per-tenant google enabled (1 test)
  O3: Kong allows public OAuth/SAML endpoints (not Kong 401) (4 tests)
  O4: Kong still enforces key-auth on protected endpoints (1 test)
  O5: GoTrue /authorize?provider=google starts redirect with tenant client_id (1 test)

Real Google sign-in (the consent screen + code exchange) requires a real Google
OAuth client and a human in a browser, so the final leg is not automatable here.
O5 verifies everything up to the redirect to accounts.google.com.

Usage:
  cd tests
  PROJECT_REF=<ref> ./RUN_TESTS.sh oauth

  # PROJECT_REF must be an existing project; this suite does not create one.
  # ADMIN_API_KEY / STUDIO_ALB / SUPABASE_DOMAIN are provided by RUN_TESTS.sh.
"""

from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

import pytest

# ---------------------------------------------------------------------------
# Configuration (provided by RUN_TESTS.sh; falls back to config.json for domain)
# ---------------------------------------------------------------------------

_config_path = os.path.join(os.path.dirname(__file__), "..", "config.json")
try:
    with open(_config_path) as _f:
        _global_config = json.load(_f)
    _default_domain = _global_config.get("domain", {}).get("baseDomain", "")
except (FileNotFoundError, json.JSONDecodeError):
    _default_domain = ""

STUDIO_ALB = os.getenv("STUDIO_ALB", "")
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "")
SUPABASE_DOMAIN = os.getenv("SUPABASE_DOMAIN", _default_domain)
PROJECT_REF = os.getenv("PROJECT_REF", "")

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE
TIMEOUT = 30

# Test provider payload — fake credentials are fine: we never reach Google,
# we only verify storage/masking and that GoTrue picks up the tenant config.
TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com"
TEST_CLIENT_SECRET = "test-secret-do-not-use"


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _request(
    method: str,
    url: str,
    *,
    headers: Optional[dict] = None,
    json_body: Any = None,
    follow_redirects: bool = True,
) -> tuple[int, Any, dict]:
    data = None
    hdrs = dict(headers or {})
    if json_body is not None:
        data = json.dumps(json_body).encode()
        hdrs["Content-Type"] = "application/json"

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_a, **_k):
            return None

    # ALB serves a cert that does not match the bare ELB hostname, so disable
    # verification here (same posture as the other suites' SSL_CTX).
    https_handler = urllib.request.HTTPSHandler(context=SSL_CTX)
    handlers = [https_handler] if follow_redirects else [https_handler, _NoRedirect()]
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        resp = opener.open(req, timeout=TIMEOUT)
        raw = resp.read().decode(errors="replace")
        return resp.status, _maybe_json(raw), dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        return e.code, _maybe_json(raw), dict(e.headers or {})


def _maybe_json(raw: str) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw}


def _tm_admin(method: str, path: str, json_body: Any = None) -> tuple[int, Any, dict]:
    """Call the tenant-manager admin API through the Studio ALB (apikey header)."""
    url = f"https://{STUDIO_ALB}{path}"
    return _request(
        method, url, headers={"Authorization": f"Bearer {ADMIN_API_KEY}"}, json_body=json_body
    )


def _auth(method: str, path: str, *, apikey: Optional[str] = None,
          follow_redirects: bool = True) -> tuple[int, Any, dict]:
    """Call /auth/v1/* through the project subdomain (Kong gateway)."""
    url = f"https://{PROJECT_REF}.{SUPABASE_DOMAIN}/auth/v1{path}"
    headers = {"apikey": apikey} if apikey else {}
    return _request(method, url, headers=headers, follow_redirects=follow_redirects)


def _is_kong_keyauth_401(status: int, headers: dict) -> bool:
    """True if the 401 came from Kong's key-auth (not GoTrue)."""
    if status != 401:
        return False
    return "key" in (headers.get("WWW-Authenticate", "") or "").lower()


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

class State:
    anon_key: str = ""


_state = State()


def _ensure_config():
    missing = [
        n for n, v in [("STUDIO_ALB", STUDIO_ALB), ("ADMIN_API_KEY", ADMIN_API_KEY),
                       ("SUPABASE_DOMAIN", SUPABASE_DOMAIN), ("PROJECT_REF", PROJECT_REF)]
        if not v
    ]
    if missing:
        pytest.skip(f"missing required config: {', '.join(missing)} (run via ./RUN_TESTS.sh oauth)")


def _ensure_anon_key():
    _ensure_config()
    if _state.anon_key:
        return
    status, body, _ = _request(
        "GET", f"https://{STUDIO_ALB}/api/v1/projects/{PROJECT_REF}/api-keys"
    )
    if status == 200 and isinstance(body, list):
        anon = next((k for k in body if k.get("name") == "anon"), None)
        if anon:
            _state.anon_key = anon.get("api_key") or ""
    if not _state.anon_key:
        pytest.skip("anon key unavailable for project")


# ---------------------------------------------------------------------------
# O0: Setup
# ---------------------------------------------------------------------------

class TestO0_Setup:
    def test_o0_fetch_anon_key(self):
        _ensure_anon_key()
        assert _state.anon_key.startswith("sb_publishable_"), _state.anon_key[:20]


# ---------------------------------------------------------------------------
# O1: Provider config CRUD (tenant-manager admin API)
# ---------------------------------------------------------------------------

class TestO1_ProviderConfig:
    PATH = property(lambda self: f"/admin/v1/projects/{PROJECT_REF}/auth/external/google")

    def test_o1a_put_provider(self):
        _ensure_config()
        status, body, _ = _tm_admin(
            "PUT", self.PATH,
            json_body={
                "enabled": True,
                "client_id": TEST_CLIENT_ID,
                "client_secret": TEST_CLIENT_SECRET,
                "redirect_uri": f"https://{PROJECT_REF}.{SUPABASE_DOMAIN}/auth/v1/callback",
            },
        )
        assert status in (200, 201), f"PUT provider failed: {status} {body}"
        data = body.get("data", body) if isinstance(body, dict) else {}
        assert data.get("enabled") is True, data
        assert data.get("client_id") == TEST_CLIENT_ID, data

    def test_o1b_get_provider_masks_secret(self):
        _ensure_config()
        status, body, _ = _tm_admin("GET", self.PATH)
        assert status == 200, f"GET provider failed: {status} {body}"
        data = body.get("data", body) if isinstance(body, dict) else {}
        # secret must NOT be returned; only a boolean indicator
        assert "client_secret" not in data, f"client_secret leaked: {data}"
        assert data.get("secret_set") is True, data
        assert data.get("client_id") == TEST_CLIENT_ID, data

    def test_o1c_delete_provider_then_restore(self):
        _ensure_config()
        status, _, _ = _tm_admin("DELETE", self.PATH)
        assert status in (200, 204), f"DELETE provider failed: {status}"
        # confirm gone
        status_get, body_get, _ = _tm_admin("GET", self.PATH)
        if status_get == 200:
            data = body_get.get("data", body_get) if isinstance(body_get, dict) else {}
            assert not data.get("enabled"), f"provider still enabled after delete: {data}"
        else:
            assert status_get in (404,), f"unexpected GET-after-delete status: {status_get}"
        # restore for the remaining tests (O2/O5 depend on it)
        status_put, _, _ = _tm_admin(
            "PUT", self.PATH,
            json_body={
                "enabled": True,
                "client_id": TEST_CLIENT_ID,
                "client_secret": TEST_CLIENT_SECRET,
                "redirect_uri": f"https://{PROJECT_REF}.{SUPABASE_DOMAIN}/auth/v1/callback",
            },
        )
        assert status_put in (200, 201), f"restore PUT failed: {status_put}"


# ---------------------------------------------------------------------------
# O2: GoTrue /settings reflects per-tenant config
# ---------------------------------------------------------------------------

class TestO2_GoTrueSettings:
    def test_o2_settings_shows_google_enabled(self):
        _ensure_anon_key()
        status, body, _ = _auth("GET", "/settings", apikey=_state.anon_key)
        assert status == 200, f"/settings failed: {status} {body}"
        external = (body or {}).get("external", {}) if isinstance(body, dict) else {}
        assert external.get("google") is True, (
            f"per-tenant google not reflected in /settings: external={external}"
        )


# ---------------------------------------------------------------------------
# O3: Kong allows the unauthenticated OAuth/SAML public endpoints
# ---------------------------------------------------------------------------

class TestO3_KongPublicEndpoints:
    """These must pass through Kong to GoTrue (no apikey). Any status is fine
    EXCEPT a Kong key-auth 401 — that means the route is still gated."""

    @pytest.mark.parametrize("path", [
        "/callback",
        "/verify",
        "/sso/saml/acs",
        "/sso/saml/metadata",
    ])
    def test_o3_public_endpoint_not_kong_gated(self, path):
        _ensure_config()
        status, _, headers = _auth(method := "GET", path, follow_redirects=False)
        assert not _is_kong_keyauth_401(status, headers), (
            f"{path} is still gated by Kong key-auth (status {status}, "
            f"WWW-Authenticate={headers.get('WWW-Authenticate')!r}); "
            f"the stale service-level key-auth self-heal may not have run"
        )


# ---------------------------------------------------------------------------
# O4: Kong still enforces key-auth on protected endpoints
# ---------------------------------------------------------------------------

class TestO4_KongProtectedEndpoints:
    def test_o4_user_requires_apikey(self):
        _ensure_config()
        status, _, headers = _auth("GET", "/user", follow_redirects=False)
        assert _is_kong_keyauth_401(status, headers), (
            f"/user should be gated by Kong key-auth, got {status} "
            f"WWW-Authenticate={headers.get('WWW-Authenticate')!r}"
        )


# ---------------------------------------------------------------------------
# O5: GoTrue /authorize starts the Google redirect chain with tenant client_id
# ---------------------------------------------------------------------------

class TestO5_AuthorizeRedirect:
    # The startup auth-schema self-heal (tenant-manager) now adds the flow_state
    # OAuth-context columns AND relaxes the legacy PKCE NOT NULL constraints on
    # every existing tenant DB, so the OAuth-redirect flow creates its flow_state
    # row and /authorize redirects to Google. This is a hard assert.
    def test_o5_authorize_redirects_to_google_with_tenant_client_id(self):
        _ensure_anon_key()
        status, body, headers = _auth(
            "GET", "/authorize?provider=google", apikey=_state.anon_key,
            follow_redirects=False,
        )
        # GoTrue answers with a 302/303 redirect to accounts.google.com.
        assert status in (302, 303), (
            f"expected redirect to Google, got {status}: "
            f"{json.dumps(body) if body else ''}"
        )
        location = headers.get("Location", "")
        assert "accounts.google.com" in location, f"unexpected redirect target: {location}"
        # the redirect must carry THIS tenant's client_id (per-tenant resolution)
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)
        assert qs.get("client_id", [""])[0] == TEST_CLIENT_ID, (
            f"redirect did not use the tenant's client_id: {qs.get('client_id')}"
        )
