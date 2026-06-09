"""
Edge Function deploy/runtime error classification tests (二期 PDF §6).

Background: the platform used to collapse three distinct failures into one
misleading 404 {"msg":"Function not found"}:
  - the function genuinely does not exist            → should be 404
  - the user's code has a SYNTAX error               → should be 422 (their bug)
  - the worker fails to boot for another reason       → should be 422 + detail

This suite verifies the two-layer fix:
  Layer 1 (deploy-time): `deno check` gates the deploy. Syntactically broken
          code is rejected at deploy with 422 + FUNCTION_VALIDATION_FAILED,
          never reaching the runtime.
  Layer 2 (runtime): main-router.ts classifies worker errors:
          boot/parse error → 422 FUNCTION_BOOT_ERROR + raw detail
          missing function → 404 FUNCTION_NOT_FOUND
          timeout          → 504 FUNCTION_TIMEOUT

Usage:
  cd tests
  PROJECT_REF=<ref> ./RUN_TESTS.sh fn-errors
"""

from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from typing import Any, Optional

import pytest

_config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
try:
    with open(_config_path) as _f:
        _default_domain = json.load(_f).get("domain", {}).get("baseDomain", "")
except (FileNotFoundError, json.JSONDecodeError):
    _default_domain = ""

STUDIO_ALB = os.getenv("STUDIO_ALB", "")
if not STUDIO_ALB:
    raise RuntimeError("STUDIO_ALB not set. Run via ./RUN_TESTS.sh fn-errors.")
STUDIO_BASE = f"https://{STUDIO_ALB}"
EXISTING_PROJECT_REF = os.getenv("PROJECT_REF", "")
SUPABASE_DOMAIN = os.getenv("SUPABASE_DOMAIN", _default_domain)

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE
TIMEOUT = 60

# A function whose code is syntactically broken — mirrors the real failures in
# the PDF logs ("Parenthesized expression cannot be empty").
BROKEN_CODE = "Deno.serve(() => { const x = (); return new Response('never') })"
# A valid function for the negative-control / 404 cases.
VALID_CODE = "Deno.serve(() => new Response('ok'))"

BROKEN_SLUG = f"broken-fn-{datetime.now().strftime('%H%M%S')}"
VALID_SLUG = f"valid-fn-{datetime.now().strftime('%H%M%S')}"
MISSING_SLUG = f"does-not-exist-{uuid.uuid4().hex[:8]}"


def api_request(method: str, path: str, body: Any = None,
                expected_status: Optional[int] = None) -> tuple[int, Any]:
    url = f"{STUDIO_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
        status, raw = resp.status, resp.read().decode()
        rb = json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read().decode()
        try:
            rb = json.loads(raw)
        except json.JSONDecodeError:
            rb = {"raw": raw}
    if expected_status is not None:
        assert status == expected_status, f"{method} {path} => {status}: {rb}"
    return status, rb


def multipart_deploy(slug: str, content: str) -> tuple[int, Any]:
    import http.client
    boundary = uuid.uuid4().hex
    raw = b"\r\n".join([
        f"--{boundary}".encode(),
        f'Content-Disposition: form-data; name="file"; filename="index.ts"'.encode(),
        b"Content-Type: text/plain",
        b"",
        content.encode(),
        f"--{boundary}--".encode(),
        b"",
    ])
    conn = http.client.HTTPSConnection(STUDIO_ALB, context=SSL_CTX, timeout=TIMEOUT)
    conn.request("POST", f"/api/v1/projects/{_state.ref}/functions/deploy?slug={slug}",
                 body=raw, headers={
                     "Content-Type": f"multipart/form-data; boundary={boundary}",
                     "Content-Length": str(len(raw)),
                 })
    resp = conn.getresponse()
    status, raw_resp = resp.status, resp.read().decode()
    conn.close()
    try:
        return status, json.loads(raw_resp)
    except json.JSONDecodeError:
        return status, {"raw": raw_resp}


def kong_invoke(slug: str, api_key: str) -> tuple[int, bytes]:
    url = f"https://{_state.ref}.{SUPABASE_DOMAIN}/functions/v1/{slug}"
    req = urllib.request.Request(
        url, data=b"{}",
        headers={"apikey": api_key, "Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json"},
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
        return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class State:
    ref: str = EXISTING_PROJECT_REF
    service_role_key: str = ""


_state = State()


def _ensure():
    if not _state.ref:
        pytest.skip("PROJECT_REF not set")
    if not _state.service_role_key:
        _, body = api_request("GET", f"/api/v1/projects/{_state.ref}/api-keys")
        if isinstance(body, list):
            sr = next((k for k in body if k.get("name") == "service_role"), None)
            if sr:
                _state.service_role_key = sr.get("api_key") or ""


# ---------------------------------------------------------------------------
# Layer 1 — deploy-time validation
# ---------------------------------------------------------------------------


class TestE1_DeployValidation:
    def test_e1_broken_code_handled(self):
        """Deploying syntactically broken code must be handled cleanly.

        Two acceptable outcomes depending on whether the deno binary is
        present in the function-deploy container:
          - deno available  → 422 FUNCTION_VALIDATION_FAILED (deploy-time gate)
          - deno absent      → 201 deploy accepted, runtime layer (E3-style)
                               will classify the boot error as 422 on invoke.
        The one outcome we must NEVER see is a misleading 500 or a 404.
        """
        _ensure()
        status, body = multipart_deploy(BROKEN_SLUG, BROKEN_CODE)
        assert status in (201, 422), (
            f"Broken code deploy should be 422 (gated) or 201 (deferred to "
            f"runtime), never 500/404; got {status}: {body}"
        )
        if status == 422:
            err = body.get("error", {}) if isinstance(body, dict) else {}
            assert err.get("code") == "FUNCTION_VALIDATION_FAILED", (
                f"422 must carry FUNCTION_VALIDATION_FAILED; got: {body}"
            )
            print("\n  Deploy-time syntax gate active (deno available)")
        else:
            print("\n  Deno validator absent — syntax gate deferred to runtime layer")

    def test_e2_valid_code_deploys_ok(self):
        """Negative control: valid code always deploys with 201."""
        _ensure()
        status, body = multipart_deploy(VALID_SLUG, VALID_CODE)
        assert status == 201, f"Valid code should deploy; got {status}: {body}"

    def test_e2b_broken_code_runtime_is_422_not_404(self):
        """If the broken function got deployed (deno absent), invoking it must
        return 422 FUNCTION_BOOT_ERROR — the core PDF §6 fix — NOT a misleading
        404. Skipped when the deploy-time gate already rejected it."""
        _ensure()
        if not _state.service_role_key:
            pytest.skip("service_role key unavailable")
        # Check whether the broken function exists (i.e. deploy was accepted).
        status, _ = api_request(
            "GET", f"/api/v1/projects/{_state.ref}/functions/{BROKEN_SLUG}"
        )
        if status != 200:
            pytest.skip("Broken function was rejected at deploy time (deno gate active)")
        inv_status, raw = kong_invoke(BROKEN_SLUG, _state.service_role_key)
        assert inv_status == 422, (
            f"Broken code at runtime must be 422 FUNCTION_BOOT_ERROR, not "
            f"misleading 404; got {inv_status}: {raw[:300]!r}"
        )
        body = json.loads(raw)
        assert body.get("code") == "FUNCTION_BOOT_ERROR", f"Expected FUNCTION_BOOT_ERROR; got {body}"
        assert "detail" in body, "Boot error must surface the raw runtime detail"


# ---------------------------------------------------------------------------
# Layer 2 — runtime classification
# ---------------------------------------------------------------------------


class TestE3_RuntimeClassification:
    def test_e3_missing_function_is_404(self):
        """Invoking a function that was never deployed → 404 FUNCTION_NOT_FOUND."""
        _ensure()
        if not _state.service_role_key:
            pytest.skip("service_role key unavailable")
        status, raw = kong_invoke(MISSING_SLUG, _state.service_role_key)
        assert status == 404, f"Missing function should be 404; got {status}: {raw[:300]!r}"
        try:
            body = json.loads(raw)
            assert body.get("code") == "FUNCTION_NOT_FOUND", (
                f"Expected FUNCTION_NOT_FOUND code; got {body}"
            )
        except json.JSONDecodeError:
            pass  # Kong-level 404 without body is also acceptable

    def test_e4_valid_function_runs(self):
        """Negative control: the valid function deployed in E2 actually runs."""
        _ensure()
        if not _state.service_role_key:
            pytest.skip("service_role key unavailable")
        status, raw = kong_invoke(VALID_SLUG, _state.service_role_key)
        assert status not in (404, 422, 500), (
            f"Valid function should run, not error; got {status}: {raw[:300]!r}"
        )

    @classmethod
    def teardown_class(cls):
        # Best-effort cleanup of the valid function (broken one never persisted).
        for slug in (VALID_SLUG, BROKEN_SLUG):
            try:
                api_request("DELETE", f"/api/v1/projects/{_state.ref}/functions/{slug}")
            except Exception:
                pass
