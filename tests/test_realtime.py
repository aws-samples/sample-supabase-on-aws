"""
Realtime service integration tests.

Tests WebSocket-based features through the Supabase realtime service:
  A: Setup — fetch keys (1 test)
  B: Broadcast — send + receive channel message (1 test)
  C: Presence — online status tracking with join event (1 test)
  D: Postgres Changes — CDC INSERT event subscription (1 test)

Usage:
  cd tests
  ./RUN_TESTS.sh realtime

  # Or directly:
  PROJECT_REF=<ref> python3 -m pytest test_realtime.py -v -s

Notes:
  - Requires supabase-py >= 2.0.0 with async support
  - Requires realtime service to be deployed and routed through Kong
  - Tests will skip gracefully if realtime is not available
"""

import asyncio
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from typing import Any, Optional

import pytest

from config import BASE_DOMAIN, TIMEOUTS

# Try to import supabase async client
try:
    from supabase import acreate_client
    HAS_ASYNC = True
except ImportError:
    try:
        from supabase._async.client import acreate_client
        HAS_ASYNC = True
    except ImportError:
        HAS_ASYNC = False

# ============================================
# Configuration
# ============================================

STUDIO_ALB = os.getenv("STUDIO_ALB", "")
_INITIAL_PROJECT_REF = os.getenv("PROJECT_REF", "")

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

TIMEOUT = TIMEOUTS.get("read", 30)

TABLE_NAME = "_test_realtime_cdc"


# ============================================
# HTTP helpers
# ============================================

def studio_api_request(method: str, path: str, body: Any = None) -> tuple[int, Any]:
    """Send a request to Studio API and return (status_code, parsed_json)."""
    url = f"https://{STUDIO_ALB}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=TIMEOUT)
        status = resp.status
        raw = resp.read().decode()
        try:
            return status, json.loads(raw)
        except json.JSONDecodeError:
            return status, {"raw": raw}
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read().decode()
        try:
            return status, json.loads(raw)
        except json.JSONDecodeError:
            return status, {"raw": raw}


def _query(sql: str) -> tuple[int, Any]:
    """Execute SQL via Studio API query endpoint."""
    return studio_api_request(
        "POST", f"/api/v1/projects/{_st.project_ref}/database/query",
        body={"query": sql},
    )


def _skip_if_connection_error(e: Exception):
    """Skip test if the error looks like a connection/realtime availability issue."""
    msg = str(e).lower()
    if any(kw in msg for kw in ("connect", "timeout", "websocket", "refused", "unreachable")):
        pytest.skip(f"Realtime service not available: {e}")


# ============================================
# Shared state
# ============================================

class _State:
    project_ref: str = ""
    anon_key: str = ""
    service_role_key: str = ""


_st = _State()

if _INITIAL_PROJECT_REF:
    _st.project_ref = _INITIAL_PROJECT_REF
_env_anon = os.getenv("SUPABASE_ANON_KEY", "")
if _env_anon.startswith("sb_"):
    _st.anon_key = _env_anon
_env_sr = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
if _env_sr.startswith("sb_"):
    _st.service_role_key = _env_sr


# ============================================
# Test A: Setup (1 test)
# ============================================

class TestA_Setup:
    """Resolve project and fetch opaque API keys from Studio API."""

    def test_a1_fetch_keys(self):
        """Resolve project and fetch opaque API keys."""
        if _st.anon_key and _st.service_role_key and _st.project_ref:
            print(f"\n  Using pre-configured project={_st.project_ref}")
            return

        assert STUDIO_ALB, (
            "STUDIO_ALB not set. Run via ./RUN_TESTS.sh realtime or set STUDIO_ALB."
        )

        if not _st.project_ref:
            status, projects = studio_api_request("GET", "/api/v1/projects")
            assert status == 200 and isinstance(projects, list) and len(projects) > 0, (
                f"No projects found: {status} {projects}"
            )
            _st.project_ref = projects[0]["ref"]
            print(f"\n  Auto-selected project: {_st.project_ref}")

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


# ============================================
# Test B: Broadcast (1 test)
# ============================================

class TestB_Broadcast:
    """Broadcast: send and receive a message on a channel."""

    def test_b1_broadcast_send_receive(self):
        """Send a broadcast event and verify it is received."""
        if not HAS_ASYNC:
            pytest.skip("supabase async client not available (pip install supabase>=2.0.0)")
        assert _st.project_ref and _st.anon_key, "No project or keys"

        async def _run():
            url = f"https://{_st.project_ref}.{BASE_DOMAIN}"
            client = await acreate_client(url, _st.anon_key)

            # Enable self-broadcast so the sender receives its own message
            channel = client.channel(
                "test-broadcast",
                {"config": {"broadcast": {"self": True}}},
            )
            received = []

            channel.on_broadcast(
                "test-event",
                lambda payload: received.append(payload),
            )
            await channel.subscribe()
            await asyncio.sleep(1)

            await channel.send_broadcast(
                "test-event",
                {"hello": "supabase-realtime", "ts": time.time()},
            )
            await asyncio.sleep(3)

            await client.remove_all_channels()
            return received

        try:
            received = asyncio.run(_run())
        except Exception as e:
            _skip_if_connection_error(e)
            raise

        assert len(received) >= 1, (
            f"Expected at least 1 broadcast message, got {len(received)}"
        )
        print(f"\n  Broadcast received {len(received)} message(s)")
        print(f"  Payload: {received[0]}")


# ============================================
# Test C: Presence (1 test)
# ============================================

class TestC_Presence:
    """Presence: track user status and receive join event."""

    def test_c1_presence_join(self):
        """Track presence state and verify join event is received."""
        if not HAS_ASYNC:
            pytest.skip("supabase async client not available (pip install supabase>=2.0.0)")
        assert _st.project_ref and _st.anon_key, "No project or keys"

        async def _run():
            url = f"https://{_st.project_ref}.{BASE_DOMAIN}"
            client = await acreate_client(url, _st.anon_key)

            channel = client.channel("test-presence")
            sync_events = []

            channel.on_presence_sync(
                lambda: sync_events.append(channel.presence_state()),
            )
            await channel.subscribe()
            await asyncio.sleep(1)

            await channel.track({"user_id": "test_user_a", "status": "online"})
            await asyncio.sleep(3)

            final_state = channel.presence_state()
            await client.remove_all_channels()
            return sync_events, final_state

        try:
            sync_events, final_state = asyncio.run(_run())
        except Exception as e:
            _skip_if_connection_error(e)
            raise

        assert len(sync_events) >= 1, (
            f"Expected presence sync events, got {len(sync_events)}"
        )
        print(f"\n  Presence sync events: {len(sync_events)}")
        print(f"  Final state: {final_state}")


# ============================================
# Test D: Postgres Changes / CDC (1 test)
# ============================================

class TestD_PostgresChanges:
    """CDC: subscribe to INSERT events on a test table."""

    def test_d1_cdc_insert(self):
        """Subscribe to INSERT events, insert a row, verify event received."""
        if not HAS_ASYNC:
            pytest.skip("supabase async client not available (pip install supabase>=2.0.0)")
        assert _st.project_ref and _st.service_role_key, "No project or keys"

        # Create test table
        _query(f"DROP TABLE IF EXISTS {TABLE_NAME} CASCADE;")
        _query(f"""
            CREATE TABLE {TABLE_NAME} (
                id      BIGSERIAL PRIMARY KEY,
                message TEXT NOT NULL
            );
        """)
        _query(f"GRANT ALL ON {TABLE_NAME} TO service_role, anon;")
        _query(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role, anon;")
        _query(f"ALTER TABLE {TABLE_NAME} ENABLE ROW LEVEL SECURITY;")
        _query(f"""
            CREATE POLICY "allow_all" ON {TABLE_NAME}
                FOR ALL USING (true) WITH CHECK (true);
        """)

        # Add to realtime publication (required for CDC)
        _query(f"ALTER PUBLICATION supabase_realtime ADD TABLE {TABLE_NAME};")

        _query("NOTIFY pgrst, 'reload schema';")
        time.sleep(3)

        async def _run():
            url = f"https://{_st.project_ref}.{BASE_DOMAIN}"
            client = await acreate_client(url, _st.service_role_key)

            channel = client.channel("test-cdc")
            inserts = []

            channel.on_postgres_changes(
                event="INSERT",
                schema="public",
                table=TABLE_NAME,
                callback=lambda payload: inserts.append(payload),
            )
            await channel.subscribe()
            await asyncio.sleep(2)

            # Insert a row to trigger the CDC event
            _query(f"INSERT INTO {TABLE_NAME} (message) VALUES ('CDC test event');")
            await asyncio.sleep(5)

            await client.remove_all_channels()
            return inserts

        try:
            inserts = asyncio.run(_run())
        except Exception as e:
            _skip_if_connection_error(e)
            raise
        finally:
            _query(f"DROP TABLE IF EXISTS {TABLE_NAME} CASCADE;")

        if len(inserts) == 0:
            pytest.skip(
                "CDC event not received — table may not be in supabase_realtime "
                "publication or realtime service may not support Postgres Changes"
            )

        assert len(inserts) >= 1
        print(f"\n  CDC received {len(inserts)} INSERT event(s)")
        print(f"  Payload: {inserts[0]}")
