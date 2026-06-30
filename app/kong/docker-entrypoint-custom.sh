#!/bin/bash
set -e

echo "[kong-init] Starting Kong in DB-backed mode..."

# Step 0: Generate kong.yml from template using envsubst
if [ -f /tmp/kong.yml.tpl ]; then
    echo "[kong-init] Processing kong.yml.tpl with envsubst..."
    envsubst '${KONG_FUNCTIONS_SERVICE_URL} ${KONG_TENANT_MANAGER_URL} ${KONG_AUTH_SERVICE_URL} ${KONG_STORAGE_SERVICE_URL} ${KONG_AWS_REGION}' \
      < /tmp/kong.yml.tpl > /tmp/kong.yml
    echo "[kong-init] kong.yml generated successfully"
else
    echo "[kong-init] WARNING: /tmp/kong.yml.tpl not found, skipping template processing"
fi

# Step 1: Bootstrap or upgrade database (preserves existing consumers)
echo "[kong-init] Running database bootstrap (or upgrade if already initialized)..."
kong migrations bootstrap 2>&1 || {
    echo "[kong-init] Database already initialized, running migrations up..."
    kong migrations up --yes 2>&1 || echo "[kong-init] Migrations already up to date"
    kong migrations finish --yes 2>&1 || echo "[kong-init] No pending migrations to finish"
}

# Step 2: Import declarative config
if [ -f /tmp/kong.yml ]; then
    echo "[kong-init] Importing declarative config..."
    kong config db_import /tmp/kong.yml 2>&1
    echo "[kong-init] Declarative config imported successfully"
fi

# Step 3: Start Kong using official entrypoint (background, so we can run the
# post-start self-heal before handing the foreground back to Kong).
echo "[kong-init] Starting Kong..."
/docker-entrypoint.sh kong docker-start &
KONG_PID=$!

# Step 4: Wait for the Admin API to come up (max ~60s). Fail-open on timeout.
echo "[kong-init] Waiting for Admin API to become ready..."
ADMIN_READY=0
for _ in $(seq 1 60); do
    if resty -e 'local h=require"resty.http".new(); h:set_timeout(2000); local r=h:request_uri("http://localhost:8001/status"); os.exit((r and r.status==200) and 0 or 1)' 2>/dev/null; then
        ADMIN_READY=1
        break
    fi
    sleep 1
done

# Step 5: Idempotently heal stale service-level auth plugins (see the script).
# Never blocks startup: the script is fail-open and we ignore its exit code.
if [ "$ADMIN_READY" = "1" ]; then
    echo "[kong-init] Admin API ready; running stale-plugin self-heal..."
    resty /heal-stale-plugins.lua || echo "[kong-init] self-heal skipped (non-fatal)"
else
    echo "[kong-init] WARN: Admin API not ready after 60s; skipping self-heal (non-fatal)"
fi

# Step 6: Hand the foreground back to Kong so the container stays alive.
echo "[kong-init] Kong running (pid $KONG_PID)"
wait "$KONG_PID"
