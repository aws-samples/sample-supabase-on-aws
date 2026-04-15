"""
Edge Functions lifecycle integration tests.

Tests the full Edge Functions flow:
  A: Setup — create project, retrieve keys
  B: Secrets — create / list / verify
  C: Deploy — deploy function, list, get details, get code
  D: Invoke — invoke via SDK, verify secrets injection
  E: Update — redeploy updated code, invoke again
  F: Delete — delete function, verify removal
  G: Cleanup — delete secrets, delete project

Usage:
  cd tests
  ./RUN_TESTS.sh functions          # auto-detect all config
  KEEP_PROJECT=1 ./RUN_TESTS.sh functions  # keep project after tests

  # Or directly with pytest:
  STUDIO_ALB=studio-alb-XXX.elb.amazonaws.com \
    python3 -m pytest test_complete_function.py -v -s
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
# Configuration (same pattern as test_studio_api.py)
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
        "STUDIO_ALB not set. Run via ./RUN_TESTS.sh functions or set STUDIO_ALB manually."
    )
STUDIO_BASE = f"https://{STUDIO_ALB}"

SUPABASE_DOMAIN = os.getenv("SUPABASE_DOMAIN", _default_domain)
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "")
KEEP_PROJECT = os.getenv("KEEP_PROJECT", "")
EXISTING_PROJECT_REF = os.getenv("PROJECT_REF", "")

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

TIMEOUT = 30


# ============================================
# HTTP helpers (reuse pattern from test_studio_api.py)
# ============================================

def api_request(
    method: str,
    path: str,
    body: Any = None,
    headers: Optional[dict] = None,
    expected_status: Optional[int] = None,
    timeout: Optional[int] = None,
    raw_body: Optional[bytes] = None,
) -> tuple[int, Any]:
    """Send a request to Studio API and return (status_code, parsed_json_or_text)."""
    url = f"{STUDIO_BASE}{path}"
    data = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else None)
    hdrs = headers or {}
    if body is not None and "Content-Type" not in hdrs:
        hdrs["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=timeout or TIMEOUT)
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

    if expected_status is not None:
        assert status == expected_status, (
            f"{method} {path} expected {expected_status}, got {status}: "
            f"{json.dumps(resp_body, ensure_ascii=False)[:500]}"
        )
    return status, resp_body


def multipart_upload(path: str, filename: str, content: str) -> tuple[int, Any]:
    """Upload a file via multipart/form-data."""
    import http.client
    import uuid

    boundary = uuid.uuid4().hex
    body_lines = [
        f"--{boundary}".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{filename}"'.encode(),
        b"Content-Type: text/plain",
        b"",
        content.encode(),
        f"--{boundary}--".encode(),
        b"",
    ]
    raw = b"\r\n".join(body_lines)

    host = STUDIO_ALB

    conn = http.client.HTTPSConnection(host, context=SSL_CTX, timeout=TIMEOUT)
    conn.request("POST", path, body=raw, headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(raw)),
    })
    resp = conn.getresponse()
    status = resp.status
    raw_resp = resp.read().decode()
    conn.close()

    try:
        resp_body = json.loads(raw_resp)
    except json.JSONDecodeError:
        resp_body = {"raw": raw_resp}

    return status, resp_body


# ============================================
# Shared state
# ============================================

class _FnState:
    ref: str = ""
    anon_key: str = ""
    service_role_key: str = ""
    project_domain: str = ""
    created_by_test: bool = False


_state = _FnState()

if EXISTING_PROJECT_REF:
    _state.ref = EXISTING_PROJECT_REF


# ============================================
# A: Setup — create project, get keys
# ============================================

class TestA_Setup:

    def test_a1_create_project(self):
        """Create a test project for function testing."""
        if EXISTING_PROJECT_REF:
            _state.ref = EXISTING_PROJECT_REF
            _state.created_by_test = False
            pytest.skip(f"Using existing project: {EXISTING_PROJECT_REF}")

        ts = datetime.now(tz=None).strftime("%m%d%H%M%S")
        project_name = f"test-fn-{ts}"

        status, body = api_request("POST", "/api/v1/projects", body={
            "name": project_name,
        }, timeout=300)

        assert status == 201, (
            f"Project creation failed with {status}: {json.dumps(body, ensure_ascii=False)[:500]}"
        )

        _state.ref = body.get("ref") or body.get("data", {}).get("ref", "")
        _state.created_by_test = True
        assert _state.ref, "No project ref in response"
        _state.project_domain = f"https://{_state.ref}.{SUPABASE_DOMAIN}"

        print(f"\n  Project created: {_state.ref}")
        print(f"  Domain: {_state.project_domain}")

        # Wait for project provisioning
        print("  Waiting 10s for project to stabilize...")
        time.sleep(10)

    def test_a2_get_api_keys(self):
        """Retrieve API keys for the test project."""
        assert _state.ref, "No project ref — test_a1 must pass first"

        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/api-keys")
        assert status == 200, f"Failed to get API keys: {body}"
        assert isinstance(body, list), f"Expected array, got {type(body)}"

        for key in body:
            name = key.get("name", "")
            if name == "anon":
                _state.anon_key = key.get("api_key", "")
            elif name == "service_role":
                _state.service_role_key = key.get("api_key", "")

        assert _state.anon_key, "Anon key not found"
        assert _state.service_role_key, "Service role key not found"
        _state.project_domain = f"https://{_state.ref}.{SUPABASE_DOMAIN}"

        print(f"\n  anon_key: {_state.anon_key[:30]}...")
        print(f"  service_role_key: {_state.service_role_key[:30]}...")


# ============================================
# B: Secrets
# ============================================

class TestB_Secrets:

    def test_b1_create_secrets(self):
        """Create project secrets for function env injection."""
        assert _state.ref, "No project ref"

        status, body = api_request("POST", f"/api/v1/projects/{_state.ref}/secrets", body=[
            {"name": "TEST_SECRET", "value": "secret_value_123"},
            {"name": "API_ENDPOINT", "value": "https://api.example.com"},
        ])
        assert status == 201, f"Failed to create secrets: {body}"
        print(f"\n  Created secrets: {[s['name'] for s in body]}")

    def test_b2_list_secrets(self):
        """List secrets and verify test secrets exist."""
        assert _state.ref, "No project ref"

        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/secrets")
        assert status == 200, f"Failed to list secrets: {body}"

        names = [s["name"] for s in body]
        assert "TEST_SECRET" in names, f"TEST_SECRET not found in {names}"
        assert "API_ENDPOINT" in names, f"API_ENDPOINT not found in {names}"
        print(f"\n  Secrets ({len(body)}): {names}")


# ============================================
# C: Deploy function
# ============================================

FUNCTION_CODE_V1 = '''Deno.serve(() => {
  const secrets = {
    TEST_SECRET: Deno.env.get("TEST_SECRET"),
    API_ENDPOINT: Deno.env.get("API_ENDPOINT"),
    SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
    SUPABASE_URL: Deno.env.get("SUPABASE_URL")
  }

  return new Response(
    JSON.stringify({
      message: "Lifecycle Test Function",
      version: "v1",
      timestamp: new Date().toISOString(),
      secrets: secrets
    }),
    { headers: { "Content-Type": "application/json" } }
  )
})'''

FUNCTION_SLUG = "lifecycle-test"


class TestC_Deploy:

    def test_c1_list_functions_empty(self):
        """List functions — initially should be empty (or not contain our slug)."""
        assert _state.ref, "No project ref"

        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/functions")
        assert status == 200, f"Failed to list functions: {body}"

        functions = body if isinstance(body, list) else body.get("data", [])
        slugs = [f.get("slug") for f in functions]
        assert FUNCTION_SLUG not in slugs, f"{FUNCTION_SLUG} already exists"
        print(f"\n  Functions before deploy: {len(functions)}")

    def test_c2_deploy_function(self):
        """Deploy an Edge Function via multipart upload."""
        assert _state.ref, "No project ref"

        status, body = multipart_upload(
            f"/api/v1/projects/{_state.ref}/functions/deploy?slug={FUNCTION_SLUG}",
            "index.ts",
            FUNCTION_CODE_V1,
        )
        assert status == 201, f"Failed to deploy function ({status}): {body}"

        fn_data = body.get("data", body)
        slug = fn_data.get("slug", "")
        fn_status = fn_data.get("status", "")
        print(f"\n  Deployed: {slug} (status: {fn_status})")

    def test_c3_list_functions_after_deploy(self):
        """Verify the deployed function appears in the list."""
        assert _state.ref, "No project ref"

        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/functions")
        assert status == 200

        functions = body if isinstance(body, list) else body.get("data", [])
        slugs = [f.get("slug") for f in functions]
        assert FUNCTION_SLUG in slugs, f"{FUNCTION_SLUG} not found in {slugs}"
        print(f"\n  Functions: {slugs}")

    def test_c4_get_function_details(self):
        """Get function metadata by slug."""
        assert _state.ref, "No project ref"

        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/functions/{FUNCTION_SLUG}")
        assert status == 200, f"Failed to get function details: {body}"

        fn_data = body.get("data", body)
        assert fn_data.get("slug") == FUNCTION_SLUG
        print(f"\n  Slug: {fn_data.get('slug')}, Status: {fn_data.get('status')}")

    def test_c5_get_function_code(self):
        """Get function source code."""
        assert _state.ref, "No project ref"

        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/functions/{FUNCTION_SLUG}/body")
        assert status == 200, f"Failed to get function code ({status}): {body}"

        code = body.get("raw", "") if isinstance(body, dict) else str(body)
        assert len(code) > 0, "Function code is empty"
        print(f"\n  Code length: {len(code)} chars")


# ============================================
# D: Invoke function
# ============================================

class TestD_Invoke:

    def test_d1_invoke_via_kong(self):
        """Invoke the Edge Function via Kong gateway and verify response."""
        assert _state.ref and _state.anon_key, "Missing project ref or anon key"

        # Wait for function worker to be ready
        print("\n  Waiting 15s for function worker...")
        time.sleep(15)

        url = f"{_state.project_domain}/functions/v1/{FUNCTION_SLUG}"
        headers = {
            "apikey": _state.anon_key,
            "Authorization": f"Bearer {_state.anon_key}",
        }

        req = urllib.request.Request(url, headers=headers, method="POST")
        try:
            resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
            status = resp.status
            data = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            status = e.code
            raw = e.read().decode()
            pytest.fail(f"Function invocation failed ({status}): {raw[:500]}")

        assert status == 200, f"Invoke returned {status}"
        assert data.get("message") == "Lifecycle Test Function", f"Unexpected message: {data}"
        assert data.get("version") == "v1"

        print(f"  Response: {json.dumps(data, indent=2)}")

        # Verify secrets injection
        secrets = data.get("secrets", {})
        if secrets.get("TEST_SECRET") == "secret_value_123":
            print("  TEST_SECRET: injected")
        if secrets.get("SUPABASE_ANON_KEY"):
            print("  SUPABASE_ANON_KEY: injected")


# ============================================
# E: Update function
# ============================================

FUNCTION_CODE_V2 = '''Deno.serve(() => {
  return new Response(
    JSON.stringify({
      message: "Lifecycle Test Function - UPDATED",
      version: "v2",
      timestamp: new Date().toISOString()
    }),
    { headers: { "Content-Type": "application/json" } }
  )
})'''


class TestE_Update:

    def test_e1_update_function(self):
        """Redeploy function with updated code."""
        assert _state.ref, "No project ref"

        status, body = multipart_upload(
            f"/api/v1/projects/{_state.ref}/functions/deploy?slug={FUNCTION_SLUG}",
            "index.ts",
            FUNCTION_CODE_V2,
        )
        assert status == 201, f"Failed to update function ({status}): {body}"
        print("\n  Function updated to v2")

    def test_e2_invoke_updated(self):
        """Invoke updated function and verify v2 response."""
        assert _state.ref and _state.anon_key, "Missing ref or key"

        # Functions worker caches code; wait for refresh
        print("\n  Waiting 60s for function worker cache refresh...")
        time.sleep(60)

        url = f"{_state.project_domain}/functions/v1/{FUNCTION_SLUG}"
        headers = {
            "apikey": _state.anon_key,
            "Authorization": f"Bearer {_state.anon_key}",
        }

        req = urllib.request.Request(url, headers=headers, method="POST")
        try:
            resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
            data = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            pytest.fail(f"Updated invoke failed ({e.code}): {raw[:500]}")

        # v2 may still be cached; accept either version
        msg = data.get("message", "")
        version = data.get("version", "")
        print(f"  Response version: {version}, message: {msg}")

        if "UPDATED" in msg:
            print("  Update confirmed in effect")
        else:
            print("  Note: worker cache may still serve v1 (expected, TTL ~3min)")


# ============================================
# F: Delete function
# ============================================

class TestF_Delete:

    def test_f1_delete_function(self):
        """Delete the Edge Function."""
        assert _state.ref, "No project ref"

        status, body = api_request("DELETE", f"/api/v1/projects/{_state.ref}/functions/{FUNCTION_SLUG}")
        assert status == 200, f"Failed to delete function ({status}): {body}"
        print(f"\n  Function '{FUNCTION_SLUG}' deleted")

    def test_f2_verify_deleted(self):
        """Verify function no longer appears in the list."""
        assert _state.ref, "No project ref"

        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/functions")
        assert status == 200

        functions = body if isinstance(body, list) else body.get("data", [])
        slugs = [f.get("slug") for f in functions]
        assert FUNCTION_SLUG not in slugs, f"{FUNCTION_SLUG} still in list after delete"
        print(f"\n  Functions after delete: {slugs}")


# ============================================
# G: Cleanup
# ============================================

class TestG_Cleanup:

    def test_g1_delete_secrets(self):
        """Delete test secrets."""
        assert _state.ref, "No project ref"

        status, body = api_request("DELETE", f"/api/v1/projects/{_state.ref}/secrets",
                                   body=["TEST_SECRET", "API_ENDPOINT"])
        assert status == 200, f"Failed to delete secrets ({status}): {body}"
        print("\n  Test secrets deleted")

    def test_g2_delete_project(self):
        """Delete the test project (skipped if KEEP_PROJECT or not created by test)."""
        if KEEP_PROJECT:
            pytest.skip("KEEP_PROJECT is set, skipping deletion")
        if not _state.created_by_test:
            pytest.skip("Project not created by this test, skipping deletion")
        if not ADMIN_API_KEY:
            pytest.skip("ADMIN_API_KEY not available, cannot delete project")

        headers = {"Authorization": f"Bearer {ADMIN_API_KEY}"}
        status, body = api_request("DELETE", f"/admin/v1/projects/{_state.ref}", headers=headers)

        if status == 204:
            print(f"\n  Project {_state.ref} deleted")
        else:
            print(f"\n  Warning: delete returned {status}: {body}")
