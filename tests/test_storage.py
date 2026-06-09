"""
Storage end-to-end integration tests (Phase 2 §1).

Acceptance:

  S0. After project creation, storage tenant is registered automatically
      (registerStorageTenant fired during provisionProject). We probe by
      listing buckets — should return [], not 404 / "tenant not found".
  S1. POST /storage/v1/bucket creates a new bucket.
  S2. GET /storage/v1/bucket lists buckets including the one we created.
  S3. POST /storage/v1/object/{bucket}/{path} uploads a small file.
  S4. GET /storage/v1/object/authenticated/{bucket}/{path} downloads it back
      with identical content.
  S5. POST /storage/v1/object/sign/{bucket}/{path} returns a signed URL.
  S6. DELETE /storage/v1/object/{bucket}/{path} removes the object.
  S7. DELETE /storage/v1/bucket/{id}/empty + DELETE /bucket/{id} cleans up.

Test isolation:
  S8. Project A's service_role key cannot see project B's bucket through
      Kong (apikey-vs-X-Project-ID mismatch should 403).

Usage:
  cd tests
  PROJECT_REF=abc ./RUN_TESTS.sh storage
"""

from __future__ import annotations

import json
import os
import ssl
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
    raise RuntimeError("STUDIO_ALB not set. Run via ./RUN_TESTS.sh storage.")
STUDIO_BASE = f"https://{STUDIO_ALB}"

EXISTING_PROJECT_REF = os.getenv("PROJECT_REF", "")
SUPABASE_DOMAIN = os.getenv("SUPABASE_DOMAIN", _default_domain)

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE
TIMEOUT = 60

BUCKET_NAME = f"test-bucket-{datetime.now().strftime('%H%M%S')}"
OBJECT_PATH = "hello.txt"
OBJECT_BODY = b"hello-from-storage-test\n"


def studio_request(
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


def storage_request(
    project_ref: str,
    api_key: str,
    method: str,
    path: str,
    *,
    body: Optional[bytes] = None,
    json_body: Any = None,
    extra_headers: Optional[dict] = None,
    timeout: int = TIMEOUT,
) -> tuple[int, bytes, dict]:
    """Hit /storage/v1/* through the project subdomain (Kong gateway)."""
    url = f"https://{project_ref}.{SUPABASE_DOMAIN}/storage/v1{path}"
    headers = {"apikey": api_key, "Authorization": f"Bearer {api_key}"}
    if json_body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(json_body).encode()
    else:
        data = body
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=timeout)
        return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers or {})


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------


class State:
    ref: str = EXISTING_PROJECT_REF
    service_role_key: str = ""


_state = State()


def _ensure_keys():
    if not _state.ref:
        pytest.skip("PROJECT_REF env var not set")
    if not _state.service_role_key:
        _, body = studio_request("GET", f"/api/v1/projects/{_state.ref}/api-keys")
        if isinstance(body, list):
            sr = next((k for k in body if k.get("name") == "service_role"), None)
            if sr:
                _state.service_role_key = sr.get("api_key") or ""
    if not _state.service_role_key:
        pytest.skip("service_role key unavailable")


# ---------------------------------------------------------------------------
# S0..S7
# ---------------------------------------------------------------------------


class TestS0_TenantRegistered:
    def test_s0_storage_tenant_responds(self):
        _ensure_keys()
        status, body, _ = storage_request(
            _state.ref, _state.service_role_key, "GET", "/bucket"
        )
        assert status == 200, (
            f"Expected storage to know about the project (200 list), got {status}: {body[:300]!r}"
        )


class TestS1_BucketCreate:
    def test_s1_create_bucket(self):
        _ensure_keys()
        status, body, _ = storage_request(
            _state.ref, _state.service_role_key, "POST", "/bucket",
            json_body={"id": BUCKET_NAME, "name": BUCKET_NAME, "public": False},
        )
        assert status in (200, 201), f"Bucket create failed: {status} {body[:300]!r}"


class TestS2_BucketList:
    def test_s2_list_includes_new_bucket(self):
        _ensure_keys()
        status, body, _ = storage_request(
            _state.ref, _state.service_role_key, "GET", "/bucket"
        )
        assert status == 200
        names = [b.get("name") for b in json.loads(body)]
        assert BUCKET_NAME in names, f"Bucket {BUCKET_NAME} missing: {names}"


class TestS3_ObjectUpload:
    def test_s3_upload(self):
        _ensure_keys()
        status, body, _ = storage_request(
            _state.ref, _state.service_role_key, "POST",
            f"/object/{BUCKET_NAME}/{OBJECT_PATH}",
            body=OBJECT_BODY,
            extra_headers={"Content-Type": "text/plain"},
        )
        assert status in (200, 201), f"Upload failed: {status} {body[:300]!r}"


class TestS4_ObjectDownload:
    def test_s4_download_round_trip(self):
        _ensure_keys()
        status, body, _ = storage_request(
            _state.ref, _state.service_role_key, "GET",
            f"/object/authenticated/{BUCKET_NAME}/{OBJECT_PATH}",
        )
        assert status == 200, f"Download failed: {status} {body[:300]!r}"
        assert body == OBJECT_BODY, f"Round-trip mismatch: {body!r}"


class TestS5_SignedUrl:
    def test_s5_signed_url(self):
        _ensure_keys()
        status, body, _ = storage_request(
            _state.ref, _state.service_role_key, "POST",
            f"/object/sign/{BUCKET_NAME}/{OBJECT_PATH}",
            json_body={"expiresIn": 60},
        )
        assert status == 200, f"Sign failed: {status} {body[:300]!r}"
        signed = json.loads(body)
        assert "signedURL" in signed or "signedUrl" in signed, signed


class TestS6_ObjectDelete:
    def test_s6_delete_object(self):
        _ensure_keys()
        status, body, _ = storage_request(
            _state.ref, _state.service_role_key, "DELETE",
            f"/object/{BUCKET_NAME}/{OBJECT_PATH}",
        )
        assert status == 200, f"Delete object failed: {status} {body[:300]!r}"


class TestS7_BucketCleanup:
    def test_s7_delete_bucket(self):
        _ensure_keys()
        # Empty first (idempotent), then delete.
        storage_request(
            _state.ref, _state.service_role_key, "POST",
            f"/bucket/{BUCKET_NAME}/empty",
        )
        status, body, _ = storage_request(
            _state.ref, _state.service_role_key, "DELETE",
            f"/bucket/{BUCKET_NAME}",
        )
        assert status == 200, f"Bucket delete failed: {status} {body[:300]!r}"
