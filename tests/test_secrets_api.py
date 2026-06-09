"""
Studio Secrets API integration tests (Phase 2 - Secrets override semantics).

Acceptance criteria for `/api/v1/projects/{ref}/secrets`:

  1. (B4) Default GET returns 4 system secrets:
         SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
         SUPABASE_URL, SUPABASE_PUBLIC_URL
  2. (B3) All values are returned in plaintext (no SHA256 digests).
  3. (B2) After POST overwriting a reserved name, GET returns the user value
         exactly once (no duplicate ANON_KEY rows).
  4. (B1) Across many sequential GETs, response shape is stable
         (we expect the same set of names every time, regardless of which
         function-deploy ECS task served the request).
  5. DELETE on a reserved name removes only the user override; the system
     default reappears in the next GET.
  6. DELETE on a user-only secret really removes it.

Usage:
  cd tests
  ./RUN_TESTS.sh secrets
  PROJECT_REF=abc123 ./RUN_TESTS.sh secrets
"""

from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request
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
        "STUDIO_ALB not set. Run via ./RUN_TESTS.sh secrets, or set STUDIO_ALB manually."
    )
STUDIO_BASE = f"https://{STUDIO_ALB}"

EXISTING_PROJECT_REF = os.getenv("PROJECT_REF", "")
SUPABASE_DOMAIN = os.getenv("SUPABASE_DOMAIN", _default_domain)

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE
TIMEOUT = 30

RESERVED = {
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_URL",
    "SUPABASE_PUBLIC_URL",
}


def api_request(
    method: str,
    path: str,
    body: Any = None,
    expected_status: Optional[int] = None,
) -> tuple[int, Any]:
    url = f"{STUDIO_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
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
            f"{method} {path} expected {expected_status}, got {status}: "
            f"{json.dumps(resp_body, ensure_ascii=False)[:500]}"
        )
    return status, resp_body


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------


class State:
    ref: str = EXISTING_PROJECT_REF
    user_secret_name: str = "PHASE2_TEST_SECRET"
    user_secret_value: str = "phase2-test-value"


_state = State()


def _ensure_ref():
    if not _state.ref:
        pytest.skip(
            "PROJECT_REF env var not set. Run TestA from test_studio_api.py first, "
            "or set PROJECT_REF=<ref> manually."
        )


def _names(secrets: list[dict]) -> list[str]:
    return [s["name"] for s in secrets]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestG_DefaultSecrets:
    """G: GET should return 4 system defaults in plaintext (B3, B4)."""

    def test_g1_default_returns_four_system_secrets(self):
        _ensure_ref()
        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/secrets",
                                   expected_status=200)
        assert isinstance(body, list), f"Expected array, got {type(body)}"
        names = set(_names(body))
        missing = RESERVED - names
        assert not missing, f"Missing system reserved names: {missing}; got names={names}"

    def test_g2_url_and_public_url_point_to_project_subdomain(self):
        _ensure_ref()
        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/secrets",
                                   expected_status=200)
        url_secret = next((s for s in body if s["name"] == "SUPABASE_URL"), None)
        public_secret = next((s for s in body if s["name"] == "SUPABASE_PUBLIC_URL"), None)
        assert url_secret is not None, "SUPABASE_URL missing"
        assert public_secret is not None, "SUPABASE_PUBLIC_URL missing"
        expected = f"https://{_state.ref}.{SUPABASE_DOMAIN}"
        assert url_secret["value"] == expected, f"SUPABASE_URL={url_secret['value']!r} != {expected!r}"
        assert public_secret["value"] == expected, (
            f"SUPABASE_PUBLIC_URL={public_secret['value']!r} != {expected!r}"
        )

    def test_g3_values_are_plaintext_not_sha256(self):
        _ensure_ref()
        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/secrets",
                                   expected_status=200)
        for secret in body:
            v = secret["value"]
            # SHA256 hex is exactly 64 lowercase hex chars and nothing else.
            looks_like_sha = len(v) == 64 and all(c in "0123456789abcdef" for c in v)
            if secret["name"] in {"SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"}:
                # System default API keys must start with their prefix.
                prefix_ok = v.startswith("sb_publishable_") or v.startswith("sb_secret_")
                assert prefix_ok, (
                    f"{secret['name']} should be opaque key with sb_ prefix, got {v!r}"
                )
            assert not looks_like_sha, (
                f"{secret['name']} value looks like SHA256 hex; expected plaintext: {v!r}"
            )


class TestH_OverrideSemantics:
    """H: User overrides reserved names without producing duplicates (B2)."""

    def test_h1_post_user_only_secret_then_visible(self):
        _ensure_ref()
        status, body = api_request("POST", f"/api/v1/projects/{_state.ref}/secrets",
                                   body=[{"name": _state.user_secret_name,
                                          "value": _state.user_secret_value}],
                                   expected_status=201)
        names = _names(body)
        assert _state.user_secret_name in names, (
            f"User secret missing from POST response: {names}"
        )

        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/secrets",
                                   expected_status=200)
        match = next((s for s in body if s["name"] == _state.user_secret_name), None)
        assert match is not None, "User secret not visible after POST"
        assert match["value"] == _state.user_secret_value, (
            f"User secret value mismatch: {match['value']!r} vs {_state.user_secret_value!r}"
        )

    def test_h2_post_overrides_reserved_name_no_duplicate(self):
        _ensure_ref()
        override = "USER_OVERRIDE_FOR_ANON"
        api_request("POST", f"/api/v1/projects/{_state.ref}/secrets",
                    body=[{"name": "SUPABASE_ANON_KEY", "value": override}],
                    expected_status=201)

        status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/secrets",
                                   expected_status=200)
        anons = [s for s in body if s["name"] == "SUPABASE_ANON_KEY"]
        assert len(anons) == 1, f"Expected exactly one SUPABASE_ANON_KEY, got {len(anons)}: {anons}"
        assert anons[0]["value"] == override, (
            f"Override not applied: {anons[0]['value']!r} != {override!r}"
        )


class TestI_DeleteSemantics:
    """I: Delete handles reserved vs user-only names correctly."""

    def test_i1_delete_reserved_falls_back_to_default(self):
        _ensure_ref()
        # Precondition: H2 has overridden SUPABASE_ANON_KEY.
        status, body = api_request("DELETE", f"/api/v1/projects/{_state.ref}/secrets",
                                   body=["SUPABASE_ANON_KEY"],
                                   expected_status=200)
        anons = [s for s in body if s["name"] == "SUPABASE_ANON_KEY"]
        assert len(anons) == 1, f"After delete, expected one ANON_KEY, got {len(anons)}"
        assert anons[0]["value"].startswith("sb_publishable_"), (
            f"After delete, ANON_KEY should fall back to sb_publishable_ default; "
            f"got {anons[0]['value']!r}"
        )

    def test_i2_delete_user_only_secret_removes_it(self):
        _ensure_ref()
        status, body = api_request("DELETE", f"/api/v1/projects/{_state.ref}/secrets",
                                   body=[_state.user_secret_name],
                                   expected_status=200)
        names = _names(body)
        assert _state.user_secret_name not in names, (
            f"User secret still present after delete: {names}"
        )


class TestJ_Consistency:
    """J: Stability across multiple sequential GETs (B1)."""

    def test_j1_repeated_gets_return_same_name_set(self):
        """
        With 2 function-deploy tasks behind the Studio ALB, a non-shared
        local cache used to make the response set vary between requests.
        This test asserts that, across 10 calls, the set of returned names
        is identical every time.
        """
        _ensure_ref()
        snapshots = []
        for _ in range(10):
            status, body = api_request("GET", f"/api/v1/projects/{_state.ref}/secrets",
                                       expected_status=200)
            snapshots.append(tuple(sorted(_names(body))))
        unique = set(snapshots)
        assert len(unique) == 1, (
            f"GET /secrets returned {len(unique)} different name sets across 10 calls "
            f"(B1 regression). Sets seen: {unique}"
        )
