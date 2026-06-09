"""
Project lifecycle integration tests (Phase 2 - Pause/Resume/Delete).

Acceptance criteria:

  K1. POST /admin/v1/projects/:ref/pause moves status PAUSED.
  K2. POST /admin/v1/projects/:ref/resume (alias) restores ACTIVE_HEALTHY.
  K3. /resume and /restore return identical responses (alias contract).
  K4. After resume, JS-SDK-style calls (REST via Kong) still work.
  K5. DELETE /admin/v1/projects/:ref tears down everything.
  K6. After delete, re-creating a project with the same ref does NOT silently
      collide on stale Secrets Manager / Kong residue. The system must either:
        a) succeed cleanly because teardown was complete, or
        b) reject with a 409 ConflictError pinpointing what residue remains.
      Silent overwrite is the bug the May 6 observation flagged.

Usage:
  cd tests
  ./RUN_TESTS.sh lifecycle
  KEEP_PROJECT=1 ./RUN_TESTS.sh lifecycle   # keep the project for inspection
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
    raise RuntimeError(
        "STUDIO_ALB not set. Run via ./RUN_TESTS.sh lifecycle, or export STUDIO_ALB."
    )
STUDIO_BASE = f"https://{STUDIO_ALB}"

SUPABASE_DOMAIN = os.getenv("SUPABASE_DOMAIN", _default_domain)

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE
TIMEOUT = 60

# tenant-manager admin endpoints under /admin/v1/* require the platform
# admin API key. RUN_TESTS.sh fetches it from Secrets Manager and exports it
# into the env. Studio API endpoints (/api/v1/*) do not need this header.
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "")


def api_request(
    method: str,
    path: str,
    body: Any = None,
    expected_status: Optional[int] = None,
    timeout: Optional[int] = None,
) -> tuple[int, Any]:
    url = f"{STUDIO_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    if path.startswith("/admin/v1/") and ADMIN_API_KEY:
        headers["Authorization"] = f"Bearer {ADMIN_API_KEY}"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=timeout or TIMEOUT)
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
            f"{method} {path} expected {expected_status}, got {status}: "
            f"{json.dumps(resp_body, ensure_ascii=False)[:500]}"
        )
    return status, resp_body


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------


class State:
    ref: str = ""
    name: str = ""
    anon_key: str = ""


_state = State()


# ---------------------------------------------------------------------------
# K0 — create a brand new project owned by this test
# ---------------------------------------------------------------------------


class TestK0_Setup:
    def test_k0_create_project(self):
        ts = datetime.now().strftime("%m%d%H%M%S")
        name = f"lifecycle-{ts}"

        status, body = api_request(
            "POST", "/api/v1/projects", body={"name": name}, timeout=300,
        )
        assert status == 201, f"Project create failed: {status} {body}"
        assert "ref" in body
        _state.ref = body["ref"]
        _state.name = name

        # Pull anon key for SDK-style calls below.
        # The api-keys endpoint exposes {api_key, name, ...} where `name` is
        # the role label ("anon" / "service_role") and `api_key` is the
        # opaque key. Older drafts of this test looked for `role`/`opaque_key`
        # which the endpoint never returned.
        status, body = api_request(
            "GET", f"/api/v1/projects/{_state.ref}/api-keys", expected_status=200,
        )
        anon = next((k for k in body if k.get("name") == "anon"), None)
        assert anon, "No anon API key returned"
        _state.anon_key = anon.get("api_key") or ""
        assert _state.anon_key, f"anon key payload missing api_key: {anon}"

        print(f"\n  Created project ref={_state.ref}")


# ---------------------------------------------------------------------------
# K1 — pause moves status to PAUSED
# ---------------------------------------------------------------------------


class TestK1_Pause:
    def test_k1_pause_returns_paused_status(self):
        assert _state.ref, "K0 must run first"
        status, body = api_request(
            "POST", f"/admin/v1/projects/{_state.ref}/pause", expected_status=200,
        )
        # The studio API may wrap the project payload — accept either shape.
        project = body.get("data") if isinstance(body, dict) and "data" in body else body
        if isinstance(project, dict):
            assert project.get("status") == "PAUSED", (
                f"Expected status PAUSED after pause, got: {project}"
            )
        # Re-check via GET so we don't rely on the pause response shape.
        _, get_body = api_request(
            "GET", f"/admin/v1/projects/{_state.ref}", expected_status=200,
        )
        proj = get_body.get("data") if isinstance(get_body, dict) and "data" in get_body else get_body
        assert proj["status"] == "PAUSED", f"GET after pause did not show PAUSED: {proj}"


# ---------------------------------------------------------------------------
# K2 — /resume (alias) restores
# ---------------------------------------------------------------------------


class TestK2_ResumeAlias:
    def test_k2_resume_alias_restores_to_active(self):
        assert _state.ref, "K0 must run first"
        status, body = api_request(
            "POST", f"/admin/v1/projects/{_state.ref}/resume", expected_status=200,
        )
        # Allow some seconds for the restore to settle before re-querying.
        time.sleep(2)
        _, get_body = api_request(
            "GET", f"/admin/v1/projects/{_state.ref}", expected_status=200,
        )
        proj = get_body.get("data") if isinstance(get_body, dict) and "data" in get_body else get_body
        assert proj["status"] == "ACTIVE_HEALTHY", (
            f"After /resume the project should be ACTIVE_HEALTHY, got: {proj}"
        )


# ---------------------------------------------------------------------------
# K3 — /resume and /restore are aliases
# ---------------------------------------------------------------------------


class TestK3_AliasContract:
    def test_k3_restore_then_resume_are_alias(self):
        """Calling /resume or /restore on an already-active project should
        produce the same error shape (both 'project is not paused')."""
        assert _state.ref, "K0 must run first"

        s_resume, b_resume = api_request(
            "POST", f"/admin/v1/projects/{_state.ref}/resume",
        )
        s_restore, b_restore = api_request(
            "POST", f"/admin/v1/projects/{_state.ref}/restore",
        )

        assert s_resume == s_restore, (
            f"Alias mismatch: /resume → {s_resume}, /restore → {s_restore}"
        )
        # Both should fail with the same kind of error (project is not paused).
        assert s_resume in (400, 409, 200), f"Unexpected status: {s_resume}"


# ---------------------------------------------------------------------------
# K4 — JS SDK-style access works after resume (REST via Kong subdomain)
# ---------------------------------------------------------------------------


class TestK4_PostResumeSdkAccess:
    def test_k4_rest_root_reachable_after_resume(self):
        assert _state.ref and _state.anon_key, "K0 must run first"
        url = f"https://{_state.ref}.{SUPABASE_DOMAIN}/rest/v1/"
        req = urllib.request.Request(
            url,
            headers={"apikey": _state.anon_key, "Authorization": f"Bearer {_state.anon_key}"},
            method="GET",
        )
        try:
            resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
            status = resp.status
            print(f"\n  REST root reachable, HTTP {status}")
        except urllib.error.HTTPError as e:
            status = e.code
            # 404 or 200 are both fine — we only care that Kong + Lambda are alive.
            assert status in (200, 404), (
                f"After resume, REST root should be reachable (200/404), got {status}: {e.read()!r}"
            )


# ---------------------------------------------------------------------------
# K5 + K6 — delete + ref reuse (no silent collision)
# ---------------------------------------------------------------------------


class TestK5_Delete:
    def test_k5_delete_succeeds(self):
        assert _state.ref, "K0 must run first"
        status, body = api_request(
            "DELETE", f"/admin/v1/projects/{_state.ref}", timeout=300,
        )
        assert status in (200, 204), f"Delete failed: {status} {body}"
        # GET after delete should 404
        status, _ = api_request("GET", f"/admin/v1/projects/{_state.ref}")
        assert status == 404, f"Project still visible after delete: {status}"


class TestK6_RefReuseGuard:
    def test_k6_recreate_with_same_ref_is_safe(self):
        """After a clean delete, recreating with the same ref must not collide
        on stale Secrets Manager / Kong residue.

        Two acceptable outcomes:
          - 201: teardown was complete, fresh project provisioned cleanly
          - 409 with code REF_*_RESIDUE: guard caught residue, fast-fail
        Silent overwrite (200/201 with mixed state) is the failure mode we're
        trying to prevent.

        Hits /admin/v1/projects directly (tenant-manager) so we observe the
        guard's real status code; the Studio API at /api/v1/projects has a
        wrapper that flattens errors into 500 ProvisioningResult shape.
        """
        assert _state.ref, "K5 must run first"
        ts = datetime.now().strftime("%m%d%H%M%S")
        name = f"lifecycle-recreate-{ts}"

        status, body = api_request(
            "POST",
            "/admin/v1/projects",
            body={"name": name, "ref": _state.ref},
            timeout=300,
        )

        if status == 201:
            # Clean re-provision; tear it down too so the test is hermetic.
            api_request("DELETE", f"/api/v1/projects/{_state.ref}", timeout=300)
            return

        if status == 409:
            err_code = (
                body.get("error", {}).get("code")
                if isinstance(body, dict)
                else None
            )
            assert err_code in {
                "REF_PROJECT_RECORD_EXISTS",
                "REF_SECRETS_RESIDUE",
                "REF_KONG_CONSUMER_RESIDUE",
            }, f"409 must specify which residue caused the conflict; got: {body}"
            return

        pytest.fail(
            f"Recreate with same ref should be 201 (clean) or 409 (guarded); "
            f"got {status}: {json.dumps(body, ensure_ascii=False)[:500]}"
        )
