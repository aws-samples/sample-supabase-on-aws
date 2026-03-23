#!/bin/bash
set -e

echo "[kong-init] Starting Kong in DB-backed mode..."

# Step 0: Generate kong.yml from template using envsubst
if [ -f /tmp/kong.yml.tpl ]; then
    echo "[kong-init] Processing kong.yml.tpl with envsubst..."
    envsubst '${KONG_FUNCTIONS_SERVICE_URL} ${KONG_TENANT_MANAGER_URL} ${KONG_AUTH_SERVICE_URL} ${KONG_AWS_REGION}' \
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

# Step 3: Start Kong using official entrypoint
echo "[kong-init] Starting Kong..."
exec /docker-entrypoint.sh kong docker-start
