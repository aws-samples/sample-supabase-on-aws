#!/bin/bash
set -e

LOG_LEVEL="${LOG_LEVEL:-INFO}"

# PostgREST Lambda Bootstrap Script
# Fetches config from tenant-manager API (default) or AWS Secrets Manager (legacy).
# Uses curl + jq for HTTP and JSON parsing.
#
# Required env vars (injected by Lambda configuration):
#   PROJECT_ID (e.g. "test-sdk-jwt")
#
# For CONFIG_SOURCE=service (default):
#   CONFIG_SERVICE_URL (e.g. "http://tenant-manager.supabase.local:3001")
#
# For CONFIG_SOURCE=secretsmanager (legacy):
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION
#   SECRET_PREFIX (e.g. "postgrest/")

CONFIG_SOURCE="${CONFIG_SOURCE:-service}"
CONFIG_SERVICE_URL="${CONFIG_SERVICE_URL:-http://tenant-manager.supabase.local:3001}"

echo "[bootstrap] Starting PostgREST Lambda bootstrap..."
[ "$LOG_LEVEL" = "DEBUG" ] && echo "[bootstrap] Config source: ${CONFIG_SOURCE}"
[ "$LOG_LEVEL" = "DEBUG" ] && echo "[bootstrap] Project ID: ${PROJECT_ID}"

# ============================================================
# Config fetchers
# ============================================================

fetch_config_from_service() {
    local url="${CONFIG_SERVICE_URL}/project/${PROJECT_ID}/postgrest-config"
    echo "[bootstrap] Fetching from: ${url}" >&2

    local response
    response=$(curl -s -w "\n%{http_code}" --fail-with-body "${url}")

    local http_code
    http_code=$(echo "${response}" | tail -1)
    local response_body
    response_body=$(echo "${response}" | sed '$d')

    if [ "${http_code}" != "200" ]; then
        echo "[bootstrap] ERROR: tenant-manager returned HTTP ${http_code}" >&2
        echo "[bootstrap] Response: ${response_body}" >&2
        return 1
    fi

    echo "${response_body}"
}

fetch_config_from_secretsmanager() {
    local secret_name="${SECRET_PREFIX}${PROJECT_ID}/config"
    local region="${AWS_REGION}"
    local service="secretsmanager"
    local host="secretsmanager.${region}.amazonaws.com"
    local endpoint="https://${host}"
    local content_type="application/x-amz-json-1.1"
    local amz_target="secretsmanager.GetSecretValue"
    local body="{\"SecretId\":\"${secret_name}\"}"

    [ "$LOG_LEVEL" = "DEBUG" ] && echo "[bootstrap] Fetching secret: ${secret_name}" >&2

    local date_stamp amz_date
    date_stamp=$(date -u +"%Y%m%d")
    amz_date=$(date -u +"%Y%m%dT%H%M%SZ")

    local payload_hash
    payload_hash=$(printf '%s' "${body}" | openssl dgst -sha256 2>/dev/null | sed 's/^.* //')

    local signed_headers="content-type;host;x-amz-date;x-amz-security-token;x-amz-target"
    local canonical_request="POST
/

content-type:${content_type}
host:${host}
x-amz-date:${amz_date}
x-amz-security-token:${AWS_SESSION_TOKEN}
x-amz-target:${amz_target}

${signed_headers}
${payload_hash}"

    local credential_scope="${date_stamp}/${region}/${service}/aws4_request"
    local canonical_request_hash
    canonical_request_hash=$(printf '%s' "${canonical_request}" | openssl dgst -sha256 2>/dev/null | sed 's/^.* //')

    local string_to_sign="AWS4-HMAC-SHA256
${amz_date}
${credential_scope}
${canonical_request_hash}"

    local date_key region_key service_key signing_key signature
    date_key=$(printf '%s' "${date_stamp}" | openssl dgst -sha256 -hmac "AWS4${AWS_SECRET_ACCESS_KEY}" 2>/dev/null | sed 's/^.* //')
    region_key=$(printf '%s' "${region}" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:${date_key}" 2>/dev/null | sed 's/^.* //')
    service_key=$(printf '%s' "${service}" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:${region_key}" 2>/dev/null | sed 's/^.* //')
    signing_key=$(printf '%s' "aws4_request" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:${service_key}" 2>/dev/null | sed 's/^.* //')
    signature=$(printf '%s' "${string_to_sign}" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:${signing_key}" 2>/dev/null | sed 's/^.* //')

    local authorization="AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY_ID}/${credential_scope}, SignedHeaders=${signed_headers}, Signature=${signature}"

    local response
    response=$(curl -s -w "\n%{http_code}" -X POST "${endpoint}" \
        -H "Content-Type: ${content_type}" \
        -H "X-Amz-Date: ${amz_date}" \
        -H "X-Amz-Target: ${amz_target}" \
        -H "X-Amz-Security-Token: ${AWS_SESSION_TOKEN}" \
        -H "Authorization: ${authorization}" \
        -d "${body}")

    local http_code
    http_code=$(echo "${response}" | tail -1)
    local response_body
    response_body=$(echo "${response}" | sed '$d')

    if [ "${http_code}" != "200" ]; then
        echo "[bootstrap] ERROR: Secrets Manager returned HTTP ${http_code}" >&2
        echo "[bootstrap] Response: ${response_body}" >&2
        return 1
    fi

    echo "${response_body}" | jq -r '.SecretString'
}

# ============================================================
# Main: Fetch config and start PostgREST
# ============================================================

echo "[bootstrap] Fetching configuration..."
start_time=$(date +%s%N 2>/dev/null || date +%s)

case "${CONFIG_SOURCE}" in
    service)
        CONFIG_JSON=$(fetch_config_from_service)
        ;;
    secretsmanager)
        CONFIG_JSON=$(fetch_config_from_secretsmanager)
        ;;
    *)
        echo "[bootstrap] ERROR: Unknown CONFIG_SOURCE: ${CONFIG_SOURCE}" >&2
        exit 1
        ;;
esac

end_time=$(date +%s%N 2>/dev/null || date +%s)

if [ -z "${CONFIG_JSON}" ] || [ "${CONFIG_JSON}" = "null" ]; then
    echo "[bootstrap] ERROR: Failed to fetch configuration" >&2
    exit 1
fi

if [ ${#start_time} -gt 10 ]; then
    elapsed_ms=$(( (end_time - start_time) / 1000000 ))
    [ "$LOG_LEVEL" = "DEBUG" ] && echo "[bootstrap] Configuration fetched in ${elapsed_ms}ms"
else
    elapsed_s=$(( end_time - start_time ))
    [ "$LOG_LEVEL" = "DEBUG" ] && echo "[bootstrap] Configuration fetched in ${elapsed_s}s"
fi

# Parse config JSON and export PostgREST environment variables
# tenant-manager returns flat PGRST_* keys; secretsmanager returns nested format
if echo "${CONFIG_JSON}" | jq -e '.PGRST_DB_URI' > /dev/null 2>&1; then
    # tenant-manager format (flat keys)
    export PGRST_DB_URI=$(echo "${CONFIG_JSON}" | jq -r '.PGRST_DB_URI')
    export PGRST_DB_SCHEMAS=$(echo "${CONFIG_JSON}" | jq -r '.PGRST_DB_SCHEMAS')
    export PGRST_DB_ANON_ROLE=$(echo "${CONFIG_JSON}" | jq -r '.PGRST_DB_ANON_ROLE')
    export PGRST_DB_USE_LEGACY_GUCS=$(echo "${CONFIG_JSON}" | jq -r '.PGRST_DB_USE_LEGACY_GUCS')
    export PGRST_JWT_SECRET=$(echo "${CONFIG_JSON}" | jq -r '.PGRST_JWT_SECRET')
else
    # Secrets Manager format (nested keys, legacy)
    export PGRST_DB_URI=$(echo "${CONFIG_JSON}" | jq -r '.database.DB_URI')
    export PGRST_DB_SCHEMAS=$(echo "${CONFIG_JSON}" | jq -r '.database.DB_SCHEMAS')
    export PGRST_DB_ANON_ROLE=$(echo "${CONFIG_JSON}" | jq -r '.database.DB_ANON_ROLE')
    export PGRST_DB_USE_LEGACY_GUCS=$(echo "${CONFIG_JSON}" | jq -r '.database.DB_USE_LEGACY_GUCS // "false"')
    export PGRST_JWT_SECRET=$(echo "${CONFIG_JSON}" | jq -r '.jwt_keys[] | select(.status=="current") | .secret')
fi

# Append TCP keepalive params to DB URI to prevent NAT Gateway idle timeout (350s)
# This keeps the LISTEN connection alive for PostgREST schema cache auto-reload
if echo "${PGRST_DB_URI}" | grep -q '?'; then
    export PGRST_DB_URI="${PGRST_DB_URI}&keepalives=1&keepalives_idle=60&keepalives_interval=10&keepalives_count=3"
else
    export PGRST_DB_URI="${PGRST_DB_URI}?keepalives=1&keepalives_idle=60&keepalives_interval=10&keepalives_count=3"
fi

# Enable LISTEN/NOTIFY channel for automatic schema cache reload
export PGRST_DB_CHANNEL_ENABLED=true
export PGRST_DB_CHANNEL=pgrst

echo "[bootstrap] Configuration loaded (source: ${CONFIG_SOURCE})"
[ "$LOG_LEVEL" = "DEBUG" ] && echo "[bootstrap] DB Schemas: ${PGRST_DB_SCHEMAS}"
[ "$LOG_LEVEL" = "DEBUG" ] && echo "[bootstrap] Anon Role: ${PGRST_DB_ANON_ROLE}"
echo "[bootstrap] DB Channel: enabled (auto schema reload)"
echo "[bootstrap] Starting PostgREST..."

exec postgrest
