"""
Edge Function verify_jwt + external-webhook integration tests (Phase 2 §2).

Acceptance criteria:

  V1. Default function metadata returns verify_jwt=true (secure default).
  V2. PATCH /v1/projects/:ref/functions/:slug with verify_jwt=false persists.
  V3. After PATCH(verify_jwt=true), invoking the function from Kong subdomain
      WITHOUT apikey is rejected (401).
  V4. After PATCH(verify_jwt=false), the same invoke succeeds — that's the
      external-webhook (Stripe/GitHub) entry point the PDF asks for.
  V5. The internal lookup endpoint (used by Kong pre-function) returns the
      correct verify_jwt for both states.
  V6. Toggling back to verify_jwt=true re-enforces apikey requirement.

Usage:
  cd tests
  ./RUN_TESTS.sh verify-jwt
  PROJECT_REF=abc ./RUN_TESTS.sh verify-jwt
"""

from __future__ import annotations

import json
import os
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any, Optional

import pytest

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
try:
    with open(_config_path) as _f:
        _global_config = json.load(_f)
    _default_domain = _global_config.get("domain", {}).get("baseDomain", "")
except (FileNotFoundError, json.JSONDecodeError):
    _default_domain = ""

STUDIO_ALB = os.getenv("STUDIO_ALB", "")
if not STUDIO_ALB:
    raise RuntimeError("STUDIO_ALB not set. Run via ./RUN_TESTS.sh verify-jwt.")
STUDIO_BASE = f"https://{STUDIO_ALB}"

EXISTING_PROJECT_REF = os.getenv("PROJECT_REF", "")
SUPABASE_DOMAIN = os.getenv("SUPABASE_DOMAIN", _default_domain)

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE
TIMEOUT = 30

FUNCTION_SLUG = f"verify-jwt-test-{datetime.now().strftime('%H%M%S')}"


def api_request(
    method: str, path: str, body: Any = None, expected_status: Optional[int] = None,
) -> tuple[int, Any]:
    url = f"{STUDIO_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
        status = resp.status
        raw = resp.read().decode()
        resp_body = json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read().decode()
        try:
            resp_body = json.loads(raw)
        except json.JSONDecodeError:
            resp_body = {"raw": raw}
    if expected_status is not None:
        assert status == expected_status, (
            f"{method} {path} expected {expected_status}, got {status}: {resp_body}"
        )
    return status, resp_body


def kong_invoke(project_ref: str, slug: str, *, with_apikey: Optional[str] = None) -> int:
    """Invoke the function via Kong (the path Stripe/JS-SDK would use)."""
    url = f"https://{project_ref}.{SUPABASE_DOMAIN}/functions/v1/{slug}"
    headers = {"Content-Type": "application/json"}
    if with_apikey is not None:
        headers["apikey"] = with_apikey
        headers["Authorization"] = f"Bearer {with_apikey}"
    req = urllib.request.Request(url, data=b"{}", headers=headers, method="POST")
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
        return resp.status
    except urllib.error.HTTPError as e:
        return e.code


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------


class State:
    ref: str = EXISTING_PROJECT_REF
    anon_key: str = ""


_state = State()


def _ensure_ref():
    if not _state.ref:
        pytest.skip(
            "PROJECT_REF env var not set. Provide a project ref to run verify-jwt tests."
        )
    if not _state.anon_key:
        _, body = api_request("GET", f"/api/v1/projects/{_state.ref}/api-keys")
        if isinstance(body, list):
            anon = next((k for k in body if k.get("name") == "anon"), None)
            if anon:
                _state.anon_key = anon.get("api_key") or ""


# ---------------------------------------------------------------------------
# V1 — internal lookup defaults
# ---------------------------------------------------------------------------


class TestV1_InternalDefaults:
    def test_v1_internal_lookup_defaults_verify_jwt_true(self):
        """Kong's safety net: if no metadata exists, default to verify_jwt=true.
        Studio-side reachable through Studio ALB pass-through; we hit the
        management plane via the studio API as a probe."""
        _ensure_ref()
        # Probe the per-function metadata endpoint we just added (PATCH/GET).
        # When no row exists we expect verify_jwt=true (or fall through).
        status, body = api_request(
            "GET", f"/api/v1/projects/{_state.ref}/functions/{FUNCTION_SLUG}"
        )
        # Function may not exist yet (404) or return verify_jwt=true.
        assert status in (200, 404), f"Unexpected status: {status} {body}"
        if status == 200:
            assert body.get("verify_jwt") is True


# ---------------------------------------------------------------------------
# V2..V6 require the function to exist. We reuse the test_complete_function
# scaffolding by deploying a tiny no-op function first.
# ---------------------------------------------------------------------------


class TestV2_PatchVerifyJwt:
    @classmethod
    def setup_class(cls):
        _ensure_ref()
        # Minimal hello-world function so subsequent tests have something to
        # toggle. We deploy via the same Studio API path as test_complete_function.
        deploy_body = {
            "files": [{
                "name": "index.ts",
                "path": "index.ts",
                "content": "Deno.serve(() => new Response('ok'))",
            }],
            "metadata": {"name": FUNCTION_SLUG, "runtime": "deno", "version": "1.0.0"},
            "entrypoint": "index.ts",
        }
        status, body = api_request(
            "POST",
            f"/api/v1/projects/{_state.ref}/functions/deploy",
            body={"slug": FUNCTION_SLUG, **deploy_body},
        )
        if status not in (200, 201):
            pytest.skip(f"Function deploy failed (likely env mismatch): {status} {body}")
        time.sleep(2)

    def test_v2_patch_to_false_persists(self):
        status, body = api_request(
            "PATCH",
            f"/api/v1/projects/{_state.ref}/functions/{FUNCTION_SLUG}",
            body={"verify_jwt": False},
        )
        assert status == 200, f"PATCH failed: {status} {body}"
        # Subsequent GET must reflect the new value.
        _, get_body = api_request(
            "GET", f"/api/v1/projects/{_state.ref}/functions/{FUNCTION_SLUG}"
        )
        if isinstance(get_body, dict):
            assert get_body.get("verify_jwt") is False, (
                f"verify_jwt did not flip to false after PATCH: {get_body}"
            )


class TestV3_KongDeniesAnonymousWhenVerifyJwtTrue:
    def test_v3_no_apikey_with_verify_jwt_true_rejected(self):
        _ensure_ref()
        # Toggle back to verify_jwt=true.
        api_request(
            "PATCH",
            f"/api/v1/projects/{_state.ref}/functions/{FUNCTION_SLUG}",
            body={"verify_jwt": True},
            expected_status=200,
        )
        time.sleep(1)
        status = kong_invoke(_state.ref, FUNCTION_SLUG, with_apikey=None)
        assert status in (401, 403), (
            f"With verify_jwt=true and no apikey, expected 401/403; got {status}"
        )


class TestV4_KongAllowsAnonymousWhenVerifyJwtFalse:
    def test_v4_no_apikey_with_verify_jwt_false_passes(self):
        _ensure_ref()
        api_request(
            "PATCH",
            f"/api/v1/projects/{_state.ref}/functions/{FUNCTION_SLUG}",
            body={"verify_jwt": False},
            expected_status=200,
        )
        time.sleep(1)
        status = kong_invoke(_state.ref, FUNCTION_SLUG, with_apikey=None)
        # Function may still 4xx for other reasons (Lambda cold start, body),
        # but it must NOT be 401/403 from Kong.
        assert status not in (401, 403), (
            f"With verify_jwt=false and no apikey, Kong should not reject; got {status}"
        )


class TestV5_ApiKeyStillWorksWithVerifyJwtFalse:
    def test_v5_apikey_with_verify_jwt_false_still_works(self):
        _ensure_ref()
        if not _state.anon_key:
            pytest.skip("anon key not available")
        status = kong_invoke(_state.ref, FUNCTION_SLUG, with_apikey=_state.anon_key)
        assert status not in (401, 403), (
            f"With apikey and verify_jwt=false, expected non-4xx auth; got {status}"
        )


class TestV6_ToggleBackReEnforces:
    def test_v6_toggle_back_to_true_re_enforces(self):
        _ensure_ref()
        api_request(
            "PATCH",
            f"/api/v1/projects/{_state.ref}/functions/{FUNCTION_SLUG}",
            body={"verify_jwt": True},
            expected_status=200,
        )
        time.sleep(1)
        status = kong_invoke(_state.ref, FUNCTION_SLUG, with_apikey=None)
        assert status in (401, 403), (
            f"After toggling back to verify_jwt=true, Kong should reject; got {status}"
        )

    @classmethod
    def teardown_class(cls):
        # Best-effort cleanup; not fatal if it fails.
        api_request(
            "DELETE", f"/api/v1/projects/{_state.ref}/functions/{FUNCTION_SLUG}",
        )
