"""
Tenant isolation tests for rest/v1 route.

Verifies that API keys from one project cannot access another project's
data via subdomain routing. Auto-creates two projects with opaque keys
(sb_publishable_xxx / sb_secret_xxx) and tests cross-tenant isolation.

Prerequisites:
  - STUDIO_ALB and SUPABASE_DOMAIN must be set (auto-detected by RUN_TESTS.sh)

Usage:
  cd tests
  ./RUN_TESTS.sh isolation

  # Or reuse existing projects:
  PROJECT_A=<ref_a> PROJECT_B=<ref_b> ./RUN_TESTS.sh isolation
"""

import json
import os
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime

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
        "STUDIO_ALB not set. Run tests via ./RUN_TESTS.sh or set manually."
    )
STUDIO_BASE = f"https://{STUDIO_ALB}"

SUPABASE_DOMAIN = os.getenv("SUPABASE_DOMAIN", _default_domain)
if not SUPABASE_DOMAIN:
    raise RuntimeError("SUPABASE_DOMAIN not set.")

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

TIMEOUT = 30
PROJECT_CREATION_TIMEOUT = 300

# ============================================
# Shared state
# ============================================

class _State:
    project_a_ref: str = ""
    project_b_ref: str = ""
    a_anon_key: str = ""
    a_svc_key: str = ""
    b_anon_key: str = ""
    b_svc_key: str = ""
    a_created_by_test: bool = False
    b_created_by_test: bool = False

_state = _State()

# ============================================
# Helpers
# ============================================

def studio_request(method, path, body=None, timeout=None):
    """Send request to Studio API, return (status, body)."""
    url = f"{STUDIO_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=timeout or TIMEOUT)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"raw": raw}


def rest_request(project_ref, path, api_key, method="GET", body=None, timeout=None):
    """Send request to rest/v1 via project subdomain, return (status, body)."""
    url = f"https://{project_ref}.{SUPABASE_DOMAIN}/rest/v1{path}"
    headers = {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=timeout or TIMEOUT)
        raw = resp.read().decode()
        try:
            return resp.status, json.loads(raw)
        except json.JSONDecodeError:
            return resp.status, {"raw": raw}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"raw": raw}


def create_project(name_suffix):
    """Create a project via Studio API. Returns (ref, name)."""
    ts = datetime.now(tz=None).strftime("%m%d%H%M%S")
    project_name = f"test-iso-{name_suffix}-{ts}"
    status, body = studio_request(
        "POST", "/api/v1/projects",
        body={"name": project_name},
        timeout=PROJECT_CREATION_TIMEOUT,
    )
    assert status == 201, f"Project creation failed: {status} {body}"
    assert body.get("status") == "ACTIVE_HEALTHY", f"Project not healthy: {body}"
    return body["ref"], body["name"]


def fetch_opaque_keys(project_ref):
    """Fetch opaque API keys for a project. Returns (anon_key, svc_key)."""
    status, data = studio_request("GET", f"/api/v1/projects/{project_ref}/api-keys")
    assert status == 200, f"Failed to fetch keys for {project_ref}: {status} {data}"

    anon_key = ""
    svc_key = ""
    for key in data:
        name = key.get("name", "")
        val = key.get("api_key", "")
        if "anon" in name.lower():
            anon_key = val
        elif "service" in name.lower():
            svc_key = val

    assert anon_key, f"No anon key found for {project_ref}: {data}"
    assert svc_key, f"No service_role key found for {project_ref}: {data}"
    assert anon_key.startswith("sb_publishable_"), (
        f"Expected opaque anon key (sb_publishable_*), got: {anon_key[:30]}..."
    )
    assert svc_key.startswith("sb_secret_"), (
        f"Expected opaque service key (sb_secret_*), got: {svc_key[:30]}..."
    )
    return anon_key, svc_key


def wait_for_schema_ready(project_ref, table, api_key, max_attempts=8):
    """Wait until PostgREST Lambda picks up a newly created table."""
    rest_base = f"https://{project_ref}.{SUPABASE_DOMAIN}/rest/v1"
    headers = {"apikey": api_key, "Authorization": f"Bearer {api_key}"}

    # Ping root to unfreeze Lambda
    req = urllib.request.Request(f"{rest_base}/", headers=headers, method="GET")
    try:
        urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
    except urllib.error.HTTPError:
        pass

    for attempt in range(1, max_attempts + 1):
        try:
            req = urllib.request.Request(
                f"{rest_base}/{table}?select=id&limit=1",
                headers=headers, method="GET",
            )
            resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
            if resp.status == 200:
                return attempt
        except urllib.error.HTTPError as e:
            if e.code == 404 and attempt < max_attempts:
                time.sleep(3)
                continue
            if attempt == max_attempts:
                raise
        time.sleep(3)

    raise RuntimeError(f"Schema not ready after {max_attempts} attempts")


def delete_project(project_ref):
    """Delete a project via Studio API."""
    status, body = studio_request("DELETE", f"/api/v1/projects/{project_ref}")
    return status, body


# ============================================
# Tests
# ============================================

@pytest.mark.order(1)
class TestSetup:
    """Setup: create two projects and fetch their opaque API keys."""

    def test_01_create_or_reuse_projects(self):
        """Create two projects (or reuse from env vars)."""
        env_a = os.getenv("PROJECT_A", "")
        env_b = os.getenv("PROJECT_B", "")

        if env_a:
            _state.project_a_ref = env_a
            _state.a_created_by_test = False
            print(f"  Reusing Project A: {env_a}")
        else:
            ref, name = create_project("a")
            _state.project_a_ref = ref
            _state.a_created_by_test = True
            print(f"  Created Project A: ref={ref}, name={name}")

        if env_b:
            _state.project_b_ref = env_b
            _state.b_created_by_test = False
            print(f"  Reusing Project B: {env_b}")
        else:
            ref, name = create_project("b")
            _state.project_b_ref = ref
            _state.b_created_by_test = True
            print(f"  Created Project B: ref={ref}, name={name}")

    def test_02_fetch_opaque_keys(self):
        """Fetch opaque API keys for both projects."""
        assert _state.project_a_ref, "Project A not set"
        assert _state.project_b_ref, "Project B not set"

        _state.a_anon_key, _state.a_svc_key = fetch_opaque_keys(_state.project_a_ref)
        print(f"  Project A ({_state.project_a_ref}): anon={_state.a_anon_key[:30]}... svc={_state.a_svc_key[:30]}...")

        _state.b_anon_key, _state.b_svc_key = fetch_opaque_keys(_state.project_b_ref)
        print(f"  Project B ({_state.project_b_ref}): anon={_state.b_anon_key[:30]}... svc={_state.b_svc_key[:30]}...")

    def test_03_create_test_table_in_b(self):
        """Create isolation_test table with data in Project B."""
        status, body = studio_request(
            "POST", f"/api/v1/projects/{_state.project_b_ref}/database/query",
            body={"query": """
                DROP TABLE IF EXISTS public.isolation_test;
                CREATE TABLE public.isolation_test (
                    id serial PRIMARY KEY,
                    secret_data text NOT NULL
                );
                INSERT INTO public.isolation_test (secret_data) VALUES ('project_b_secret_123');
                GRANT SELECT, INSERT, UPDATE, DELETE ON public.isolation_test TO anon;
                GRANT SELECT, INSERT, UPDATE, DELETE ON public.isolation_test TO service_role;
                GRANT USAGE, SELECT ON SEQUENCE public.isolation_test_id_seq TO anon;
                GRANT USAGE, SELECT ON SEQUENCE public.isolation_test_id_seq TO service_role;
            """},
        )
        assert status == 200, f"Failed to create table: {status} {body}"

        attempts = wait_for_schema_ready(
            _state.project_b_ref, "isolation_test", _state.b_svc_key,
        )
        print(f"  Created isolation_test in Project B (schema ready after {attempts} attempt(s))")


@pytest.mark.order(2)
class TestSelfAccess:
    """Verify normal self-access works (baseline)."""

    def test_04_b_service_reads_own_data(self):
        """Project B's service_role key can read B's data."""
        status, data = rest_request(
            _state.project_b_ref, "/isolation_test?select=*", _state.b_svc_key,
        )
        assert status == 200, f"Self-access failed: {status} {data}"
        assert len(data) >= 1, f"Expected data, got: {data}"
        assert data[0]["secret_data"] == "project_b_secret_123"
        print(f"  B service_role reads own data OK: {data}")

    def test_05_b_anon_reads_own_data(self):
        """Project B's anon key can read B's data (granted via GRANT)."""
        status, data = rest_request(
            _state.project_b_ref, "/isolation_test?select=*", _state.b_anon_key,
        )
        assert status == 200, f"Anon self-access failed: {status} {data}"
        assert len(data) >= 1, f"Expected data, got: {data}"
        print(f"  B anon reads own data OK: {len(data)} row(s)")


@pytest.mark.order(3)
class TestCrossProjectBlocked:
    """Cross-project access must be blocked.

    When project A's key is used on project B's subdomain, Kong's
    cross-tenant isolation check detects the mismatch and returns 403.
    """

    def test_06_cross_read_service_key(self):
        """A's service_role key reading B's subdomain -> blocked."""
        status, data = rest_request(
            _state.project_b_ref, "/isolation_test?select=*", _state.a_svc_key,
        )
        assert status in (401, 403), f"Expected 401/403, got {status}: {data}"
        print(f"  Cross-read (A svc -> B): blocked with {status}")

    def test_07_cross_read_anon_key(self):
        """B's anon key reading A's subdomain -> blocked."""
        status, data = rest_request(
            _state.project_a_ref, "/isolation_test?select=*", _state.b_anon_key,
        )
        assert status in (401, 403), f"Expected 401/403, got {status}: {data}"
        print(f"  Cross-read (B anon -> A): blocked with {status}")

    def test_08_cross_write(self):
        """A's service_role key writing to B's subdomain -> blocked."""
        status, data = rest_request(
            _state.project_b_ref, "/isolation_test", _state.a_svc_key,
            method="POST",
            body={"secret_data": "injected_by_a"},
        )
        assert status in (401, 403), f"Expected 401/403, got {status}: {data}"
        print(f"  Cross-write (A svc -> B): blocked with {status}")

    def test_09_cross_delete(self):
        """A's service_role key deleting from B's subdomain -> blocked."""
        status, data = rest_request(
            _state.project_b_ref, "/isolation_test?id=gt.0", _state.a_svc_key,
            method="DELETE",
        )
        assert status in (401, 403), f"Expected 401/403, got {status}: {data}"
        print(f"  Cross-delete (A svc -> B): blocked with {status}")

    def test_10_verify_data_untouched(self):
        """Verify B's data is intact after cross-project attack attempts."""
        status, data = rest_request(
            _state.project_b_ref, "/isolation_test?select=*", _state.b_svc_key,
        )
        assert status == 200, f"Verification read failed: {status} {data}"
        assert len(data) == 1, f"Expected 1 row (original), got {len(data)}: {data}"
        assert data[0]["secret_data"] == "project_b_secret_123", (
            f"Data tampered! Expected 'project_b_secret_123', got '{data[0]['secret_data']}'"
        )
        print(f"  B's data intact: {data[0]['secret_data']}")


@pytest.mark.order(4)
class TestCleanup:
    """Cleanup test data."""

    def test_11_drop_test_table(self):
        """Drop isolation_test table from Project B."""
        status, _ = studio_request(
            "POST", f"/api/v1/projects/{_state.project_b_ref}/database/query",
            body={"query": "DROP TABLE IF EXISTS public.isolation_test;"},
        )
        assert status == 200, f"Cleanup failed: {status}"
        print("  Dropped isolation_test table from Project B")
