#!/usr/bin/env bash
#
# Provision a worker RDS instance into tenant-manager, then create a test project.
#
# Prerequisites:
#   - AWS CLI configured (aws sts get-caller-identity)
#   - cdk deploy completed (Worker RDS exists)
#   - Studio ALB accessible (routes /admin/v1/* to tenant-manager)
#   - jq installed
#
# Usage:
#   ./scripts/provision-worker-and-create-project.sh
#
# Environment variables (override defaults):
#   STUDIO_BASE_URL    - Studio ALB URL (auto-detected from CloudFormation)
#   ADMIN_API_KEY      - tenant-manager admin key (auto-detected from Secrets Manager)
#   STACK_NAME         - CloudFormation stack name (default: SupabaseStack)
#   REGION             - AWS region (default: from config.json, fallback us-east-1)
#   WORKER_IDENTIFIER  - worker instance identifier (default: supabase-worker-01)
#   PROJECT_NAME       - project name to create (default: test-worker-project)
#
set -euo pipefail

# ── Color / logging helpers (must be defined before use) ─────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ── Configuration ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/../config.json"
if [ -z "${REGION:-}" ] && [ -f "$CONFIG_FILE" ]; then
  REGION=$(jq -r '.project.region // empty' "$CONFIG_FILE" 2>/dev/null) || true
fi
REGION="${REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-SupabaseStack}"
if [ -z "${ADMIN_API_KEY:-}" ]; then
  ADMIN_API_KEY=$(aws secretsmanager get-secret-value \
    --secret-id "supabase/admin-api-key" \
    --region "$REGION" \
    --query 'SecretString' \
    --output text 2>/dev/null) || fail "Cannot read ADMIN_API_KEY from Secrets Manager. Set ADMIN_API_KEY env var or ensure supabase/admin-api-key secret exists."
fi
WORKER_IDENTIFIER="${WORKER_IDENTIFIER:-supabase-worker-01}"
PROJECT_NAME="${PROJECT_NAME:-test-worker-project}"

# ── Pre-flight checks ───────────────────────────────────────────────
command -v aws  >/dev/null 2>&1 || fail "aws CLI not found"
command -v jq   >/dev/null 2>&1 || fail "jq not found"
command -v curl >/dev/null 2>&1 || fail "curl not found"

log "Verifying AWS credentials..."
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || fail "AWS credentials invalid"
ok "AWS credentials OK"

# ── Step 1: Fetch CloudFormation outputs ─────────────────────────────
log "Fetching CloudFormation outputs from stack: $STACK_NAME ..."

CFN_OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs' \
  --output json 2>/dev/null) || fail "Cannot read CloudFormation stack $STACK_NAME"

get_output() {
  echo "$CFN_OUTPUTS" | jq -r ".[] | select(.OutputKey==\"$1\") | .OutputValue"
}

WORKER_RDS_ENDPOINT=$(get_output "WorkerRdsEndpoint")
WORKER_RDS_SECRET_ARN=$(get_output "WorkerRdsSecretArn")
STUDIO_ALB_DNS=$(get_output "StudioALBDnsName")

[ -z "$WORKER_RDS_ENDPOINT" ]    && fail "WorkerRdsEndpoint not found in stack outputs"
[ -z "$WORKER_RDS_SECRET_ARN" ]  && fail "WorkerRdsSecretArn not found in stack outputs"
[ -z "$STUDIO_ALB_DNS" ]         && fail "StudioALBDnsName not found in stack outputs"

STUDIO_BASE_URL="${STUDIO_BASE_URL:-https://${STUDIO_ALB_DNS}}"

ok "Worker RDS Endpoint:  $WORKER_RDS_ENDPOINT"
ok "Worker RDS Secret:    $WORKER_RDS_SECRET_ARN"
ok "Studio ALB URL:       $STUDIO_BASE_URL"

# ── Step 2: Retrieve worker RDS password from Secrets Manager ────────
log "Retrieving worker RDS password from Secrets Manager..."

WORKER_SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$WORKER_RDS_SECRET_ARN" \
  --region "$REGION" \
  --query 'SecretString' \
  --output text 2>/dev/null) || fail "Cannot read worker RDS secret"

WORKER_RDS_PASSWORD=$(echo "$WORKER_SECRET_JSON" | jq -r '.password')
WORKER_RDS_USER=$(echo "$WORKER_SECRET_JSON" | jq -r '.username // "postgres"')
WORKER_RDS_PORT=$(echo "$WORKER_SECRET_JSON" | jq -r '.port // 5432')

[ -z "$WORKER_RDS_PASSWORD" ] && fail "Cannot parse password from secret"
ok "Worker RDS credentials retrieved (user: $WORKER_RDS_USER)"

# ── Step 3: Health check tenant-manager ──────────────────────────────
log "Checking tenant-manager health (via Studio ALB)..."

TM_HEALTH=$(curl -sk -o /dev/null -w '%{http_code}' "${STUDIO_BASE_URL}/health/live" 2>/dev/null) || true
if [ "$TM_HEALTH" != "200" ]; then
  fail "Tenant-manager health check failed (HTTP $TM_HEALTH). Is Studio ALB routing /health/* to tenant-manager?"
fi
ok "Tenant-manager is healthy (via Studio ALB)"

# ── Step 4: Check if worker instance already registered ──────────────
log "Checking if worker instance '$WORKER_IDENTIFIER' is already registered..."

EXISTING=$(curl -sk -w '\n%{http_code}' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  "${STUDIO_BASE_URL}/admin/v1/rds-instances?status=active" 2>/dev/null)

EXISTING_HTTP=$(echo "$EXISTING" | tail -1)
EXISTING_BODY=$(echo "$EXISTING" | sed '$d')

INSTANCE_EXISTS="false"
if [ "$EXISTING_HTTP" = "200" ]; then
  INSTANCE_EXISTS=$(echo "$EXISTING_BODY" | jq -r \
    --arg id "$WORKER_IDENTIFIER" \
    '.data // [] | map(select(.identifier == $id)) | length > 0')
fi

if [ "$INSTANCE_EXISTS" = "true" ]; then
  warn "Worker instance '$WORKER_IDENTIFIER' already registered, skipping registration"
  INSTANCE_ID=$(echo "$EXISTING_BODY" | jq -r \
    --arg id "$WORKER_IDENTIFIER" \
    '.data[] | select(.identifier == $id) | .id')
  ok "Existing instance ID: $INSTANCE_ID"
else
  # ── Step 5: Register worker RDS instance ─────────────────────────
  log "Registering worker RDS instance '$WORKER_IDENTIFIER' ..."

  REGISTER_PAYLOAD=$(jq -n \
    --arg identifier "$WORKER_IDENTIFIER" \
    --arg name "Worker RDS 01" \
    --arg host "$WORKER_RDS_ENDPOINT" \
    --argjson port "$WORKER_RDS_PORT" \
    --arg admin_user "$WORKER_RDS_USER" \
    --arg admin_password "$WORKER_RDS_PASSWORD" \
    --arg auth_method "password" \
    --arg region "$REGION" \
    --argjson weight 100 \
    --argjson max_databases 100 \
    '{
      identifier: $identifier,
      name: $name,
      host: $host,
      port: $port,
      admin_user: $admin_user,
      admin_password: $admin_password,
      auth_method: $auth_method,
      region: $region,
      weight: $weight,
      max_databases: $max_databases
    }')

  REGISTER_RESP=$(curl -sk -w '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$REGISTER_PAYLOAD" \
    "${STUDIO_BASE_URL}/admin/v1/rds-instances" 2>/dev/null)

  REGISTER_HTTP=$(echo "$REGISTER_RESP" | tail -1)
  REGISTER_BODY=$(echo "$REGISTER_RESP" | sed '$d')

  if [ "$REGISTER_HTTP" != "201" ] && [ "$REGISTER_HTTP" != "200" ]; then
    echo "$REGISTER_BODY" | jq . 2>/dev/null || echo "$REGISTER_BODY"
    fail "Failed to register worker instance (HTTP $REGISTER_HTTP)"
  fi

  INSTANCE_ID=$(echo "$REGISTER_BODY" | jq -r '.data.id // .id // empty')
  ok "Worker instance registered (ID: $INSTANCE_ID)"
  echo "$REGISTER_BODY" | jq '.data // .' 2>/dev/null
fi

# Ensure INSTANCE_ID is a numeric value
if ! [[ "$INSTANCE_ID" =~ ^[0-9]+$ ]]; then
  fail "INSTANCE_ID is not numeric: '$INSTANCE_ID'"
fi

# ── Step 6: Test credentials connectivity ────────────────────────────
log "Testing worker instance credentials via tenant-manager..."

if [ -n "$INSTANCE_ID" ]; then
  TEST_RESP=$(curl -sk -w '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    "${STUDIO_BASE_URL}/admin/v1/rds-instances/${INSTANCE_ID}/test-credentials" 2>/dev/null)

  TEST_HTTP=$(echo "$TEST_RESP" | tail -1)
  TEST_BODY=$(echo "$TEST_RESP" | sed '$d')

  if [ "$TEST_HTTP" = "200" ]; then
    ok "Credential test passed"
  else
    warn "Credential test returned HTTP $TEST_HTTP (may be expected if endpoint not reachable from TM yet)"
    echo "$TEST_BODY" | jq . 2>/dev/null || echo "$TEST_BODY"
  fi
fi

# ── Step 7: Create a project on the worker instance ──────────────────
log "Creating project '$PROJECT_NAME' on worker instance '$WORKER_IDENTIFIER' ..."

PROJECT_PAYLOAD=$(jq -n \
  --arg name "$PROJECT_NAME" \
  --argjson db_instance_id "$INSTANCE_ID" \
  '{
    name: $name,
    db_instance_id: $db_instance_id
  }')

PROJECT_RESP=$(curl -sk -w '\n%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PROJECT_PAYLOAD" \
  "${STUDIO_BASE_URL}/admin/v1/projects" 2>/dev/null)

PROJECT_HTTP=$(echo "$PROJECT_RESP" | tail -1)
PROJECT_BODY=$(echo "$PROJECT_RESP" | sed '$d')

if [ "$PROJECT_HTTP" != "201" ] && [ "$PROJECT_HTTP" != "200" ]; then
  echo "$PROJECT_BODY" | jq . 2>/dev/null || echo "$PROJECT_BODY"
  fail "Failed to create project (HTTP $PROJECT_HTTP)"
fi

PROJECT_REF=$(echo "$PROJECT_BODY" | jq -r '.data.ref // .ref // .data.project_ref // empty')
ANON_KEY=$(echo "$PROJECT_BODY" | jq -r '.data.api_keys[]? | select(.name == "anon" or .key_type == "publishable") | .api_key // .key_value // empty' | head -1)
SERVICE_KEY=$(echo "$PROJECT_BODY" | jq -r '.data.api_keys[]? | select(.name == "service_role" or .key_type == "secret") | .api_key // .key_value // empty' | head -1)

ok "Project created!"
echo "$PROJECT_BODY" | jq '.data // .' 2>/dev/null

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Provisioning Complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Worker RDS:     ${CYAN}$WORKER_RDS_ENDPOINT${NC}"
echo -e "  Instance ID:    ${CYAN}$WORKER_IDENTIFIER${NC}"
echo -e "  Project Ref:    ${CYAN}${PROJECT_REF:-N/A}${NC}"
[ -n "${ANON_KEY:-}" ]    && echo -e "  Anon Key:       ${CYAN}$ANON_KEY${NC}"
[ -n "${SERVICE_KEY:-}" ] && echo -e "  Service Key:    ${CYAN}$SERVICE_KEY${NC}"
echo ""

# ── Step 8: Verify project via API ───────────────────────────────────
if [ -n "$PROJECT_REF" ]; then
  log "Verifying project '$PROJECT_REF' ..."

  VERIFY_RESP=$(curl -sk -w '\n%{http_code}' \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    "${STUDIO_BASE_URL}/admin/v1/projects/${PROJECT_REF}" 2>/dev/null)

  VERIFY_HTTP=$(echo "$VERIFY_RESP" | tail -1)
  VERIFY_BODY=$(echo "$VERIFY_RESP" | sed '$d')

  if [ "$VERIFY_HTTP" = "200" ]; then
    PROJECT_STATUS=$(echo "$VERIFY_BODY" | jq -r '.data.status // .status // "unknown"')
    ok "Project verified (status: $PROJECT_STATUS)"
  else
    warn "Project verification returned HTTP $VERIFY_HTTP"
  fi
fi

log "Done."
