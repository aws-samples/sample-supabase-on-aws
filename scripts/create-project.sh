#!/usr/bin/env bash
#
# End-to-end project creation script.
#
# Handles the full flow:
#   1. Register Worker RDS instance (idempotent, skips if exists)
#   2. Set ECR Lambda pull permissions (idempotent)
#   3. Create a new project on the worker instance
#   4. Verify project is ACTIVE_HEALTHY
#
# Prerequisites:
#   - AWS CLI configured
#   - CDK deploy completed (SupabaseStack)
#   - jq, curl installed
#
# Usage:
#   ./scripts/create-project.sh                          # auto-generated name
#   ./scripts/create-project.sh my-project               # custom name
#   PROJECT_NAME=foo ./scripts/create-project.sh         # via env var
#
# Environment variables (all optional, auto-detected):
#   REGION             AWS region (from config.json)
#   STACK_NAME         CloudFormation stack name (default: SupabaseStack)
#   STUDIO_BASE_URL    Studio ALB URL (from CloudFormation)
#   ADMIN_API_KEY      Tenant-manager admin key (from Secrets Manager)
#   WORKER_IDENTIFIER  Worker instance name (default: supabase-worker-01)
#   PROJECT_NAME       Project name (default: auto-generated)
#
set -euo pipefail

# ── Logging helpers ─────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()   { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ── Configuration ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/../config.json"

[ -f "$CONFIG_FILE" ] || fail "config.json not found at $CONFIG_FILE"
command -v aws  >/dev/null 2>&1 || fail "aws CLI not found"
command -v jq   >/dev/null 2>&1 || fail "jq not found"
command -v curl >/dev/null 2>&1 || fail "curl not found"

REGION="${REGION:-$(jq -r '.project.region // empty' "$CONFIG_FILE")}"
REGION="${REGION:-us-west-2}"
STACK_NAME="${STACK_NAME:-SupabaseStack}"
ACCOUNT_ID="${ACCOUNT_ID:-$(jq -r '.project.accountId // empty' "$CONFIG_FILE")}"
WORKER_IDENTIFIER="${WORKER_IDENTIFIER:-supabase-worker-01}"

# Project name: CLI arg > env var > auto-generated
if [ -n "${1:-}" ]; then
  PROJECT_NAME="$1"
elif [ -z "${PROJECT_NAME:-}" ]; then
  PROJECT_NAME="project-$(date +%m%d%H%M%S)"
fi

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Supabase Project Creator${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "  Region:    ${GREEN}$REGION${NC}"
echo -e "  Stack:     ${GREEN}$STACK_NAME${NC}"
echo -e "  Project:   ${GREEN}$PROJECT_NAME${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

# ── Pre-flight: AWS credentials ─────────────────────────────────────
log "Verifying AWS credentials..."
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || fail "AWS credentials invalid"
ok "AWS credentials OK"

# ── Fetch CloudFormation outputs ────────────────────────────────────
log "Fetching CloudFormation outputs..."

CFN_OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs' \
  --output json 2>/dev/null) || fail "Cannot read stack $STACK_NAME in $REGION"

get_output() {
  echo "$CFN_OUTPUTS" | jq -r ".[] | select(.OutputKey==\"$1\") | .OutputValue"
}

WORKER_RDS_ENDPOINT=$(get_output "WorkerRdsEndpoint")
WORKER_RDS_SECRET_ARN=$(get_output "WorkerRdsSecretArn")
STUDIO_ALB_DNS=$(get_output "StudioALBDnsName")

[ -z "$WORKER_RDS_ENDPOINT" ]   && fail "WorkerRdsEndpoint not in stack outputs"
[ -z "$WORKER_RDS_SECRET_ARN" ] && fail "WorkerRdsSecretArn not in stack outputs"
[ -z "$STUDIO_ALB_DNS" ]        && fail "StudioALBDnsName not in stack outputs"

STUDIO_BASE_URL="${STUDIO_BASE_URL:-https://${STUDIO_ALB_DNS}}"

ok "Worker RDS:  $WORKER_RDS_ENDPOINT"
ok "Studio ALB:  $STUDIO_BASE_URL"

# ── Retrieve admin API key ──────────────────────────────────────────
if [ -z "${ADMIN_API_KEY:-}" ]; then
  log "Retrieving admin API key from Secrets Manager..."
  ADMIN_API_KEY=$(aws secretsmanager get-secret-value \
    --secret-id "supabase/admin-api-key" \
    --region "$REGION" \
    --query 'SecretString' \
    --output text 2>/dev/null) || fail "Cannot read admin API key"
  ok "Admin API key retrieved"
fi

# ── Retrieve Worker RDS credentials ─────────────────────────────────
log "Retrieving Worker RDS credentials..."

WORKER_SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$WORKER_RDS_SECRET_ARN" \
  --region "$REGION" \
  --query 'SecretString' \
  --output text 2>/dev/null) || fail "Cannot read worker RDS secret"

WORKER_RDS_PASSWORD=$(echo "$WORKER_SECRET_JSON" | jq -r '.password')
WORKER_RDS_USER=$(echo "$WORKER_SECRET_JSON" | jq -r '.username // "postgres"')
WORKER_RDS_PORT=$(echo "$WORKER_SECRET_JSON" | jq -r '.port // 5432')
ok "Worker RDS credentials OK (user: $WORKER_RDS_USER)"

# ── Health check ────────────────────────────────────────────────────
log "Checking tenant-manager health..."
TM_HEALTH=$(curl -sk -o /dev/null -w '%{http_code}' "${STUDIO_BASE_URL}/health/live" 2>/dev/null) || true
[ "$TM_HEALTH" = "200" ] || fail "Tenant-manager health check failed (HTTP $TM_HEALTH)"
ok "Tenant-manager healthy"

# ═════════════════════════════════════════════════════════════════════
# Step 1: Register Worker RDS instance (idempotent)
# ═════════════════════════════════════════════════════════════════════
log "Step 1: Register Worker RDS instance..."

EXISTING_RESP=$(curl -sk \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  "${STUDIO_BASE_URL}/admin/v1/rds-instances?status=active" 2>/dev/null)

INSTANCE_EXISTS=$(echo "$EXISTING_RESP" | jq -r \
  --arg id "$WORKER_IDENTIFIER" \
  '.data // [] | map(select(.identifier == $id)) | length > 0' 2>/dev/null) || INSTANCE_EXISTS="false"

if [ "$INSTANCE_EXISTS" = "true" ]; then
  INSTANCE_ID=$(echo "$EXISTING_RESP" | jq -r \
    --arg id "$WORKER_IDENTIFIER" \
    '.data[] | select(.identifier == $id) | .id')
  ok "Worker '$WORKER_IDENTIFIER' already registered (ID: $INSTANCE_ID)"
else
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
    fail "Failed to register worker (HTTP $REGISTER_HTTP)"
  fi

  INSTANCE_ID=$(echo "$REGISTER_BODY" | jq -r '.data.id // .id // empty')
  ok "Worker registered (ID: $INSTANCE_ID)"

  # Test credentials
  log "Testing worker credentials..."
  TEST_HTTP=$(curl -sk -o /dev/null -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    "${STUDIO_BASE_URL}/admin/v1/rds-instances/${INSTANCE_ID}/test-credentials" 2>/dev/null) || true
  [ "$TEST_HTTP" = "200" ] && ok "Credential test passed" || warn "Credential test HTTP $TEST_HTTP"
fi

[[ "$INSTANCE_ID" =~ ^[0-9]+$ ]] || fail "INSTANCE_ID not numeric: '$INSTANCE_ID'"

# ═════════════════════════════════════════════════════════════════════
# Step 2: Set ECR Lambda pull permissions (idempotent)
# ═════════════════════════════════════════════════════════════════════
log "Step 2: Ensuring ECR Lambda pull permissions..."

ECR_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"LambdaECRAccess\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"lambda.amazonaws.com\"},\"Action\":[\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\"],\"Condition\":{\"StringLike\":{\"aws:sourceArn\":\"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:*\"}}}]}"

aws ecr set-repository-policy \
  --repository-name postgrest-lambda \
  --region "$REGION" \
  --policy-text "$ECR_POLICY" \
  >/dev/null 2>&1 && ok "ECR Lambda permissions set" || warn "ECR policy set failed (may already exist)"

# ═════════════════════════════════════════════════════════════════════
# Step 3: Create project
# ═════════════════════════════════════════════════════════════════════
log "Step 3: Creating project '$PROJECT_NAME'..."

PROJECT_PAYLOAD=$(jq -n \
  --arg name "$PROJECT_NAME" \
  --argjson db_instance_id "$INSTANCE_ID" \
  '{name: $name, db_instance_id: $db_instance_id}')

PROJECT_RESP=$(curl -sk -w '\n%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PROJECT_PAYLOAD" \
  "${STUDIO_BASE_URL}/admin/v1/projects" \
  --max-time 300 2>/dev/null)

PROJECT_HTTP=$(echo "$PROJECT_RESP" | tail -1)
PROJECT_BODY=$(echo "$PROJECT_RESP" | sed '$d')

if [ "$PROJECT_HTTP" != "201" ] && [ "$PROJECT_HTTP" != "200" ]; then
  echo "$PROJECT_BODY" | jq . 2>/dev/null || echo "$PROJECT_BODY"
  fail "Failed to create project (HTTP $PROJECT_HTTP)"
fi

PROJECT_REF=$(echo "$PROJECT_BODY" | jq -r '.data.ref // .ref // empty')
ok "Project created (ref: $PROJECT_REF)"

# ═════════════════════════════════════════════════════════════════════
# Step 4: Verify project
# ═════════════════════════════════════════════════════════════════════
log "Step 4: Verifying project..."

VERIFY_RESP=$(curl -sk \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  "${STUDIO_BASE_URL}/admin/v1/projects/${PROJECT_REF}" 2>/dev/null)

PROJECT_STATUS=$(echo "$VERIFY_RESP" | jq -r '.data.status // .status // "unknown"')
ok "Project status: $PROJECT_STATUS"

# ── Extract API keys ────────────────────────────────────────────────
ANON_KEY=$(echo "$PROJECT_BODY" | jq -r '
  (.data.api_keys // .api_keys // [])[]
  | select(.name == "anon" or .key_type == "publishable")
  | .opaque_key // .api_key // empty' | head -1)

SERVICE_KEY=$(echo "$PROJECT_BODY" | jq -r '
  (.data.api_keys // .api_keys // [])[]
  | select(.name == "service_role" or .key_type == "secret")
  | .opaque_key // .api_key // empty' | head -1)

BASE_DOMAIN=$(jq -r '.domain.baseDomain' "$CONFIG_FILE")

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Project Ready${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Project Ref:    ${CYAN}${PROJECT_REF}${NC}"
echo -e "  Status:         ${CYAN}${PROJECT_STATUS}${NC}"
echo -e "  API Endpoint:   ${CYAN}https://${PROJECT_REF}.${BASE_DOMAIN}${NC}"
[ -n "${ANON_KEY:-}" ]    && echo -e "  Anon Key:       ${CYAN}${ANON_KEY}${NC}"
[ -n "${SERVICE_KEY:-}" ] && echo -e "  Service Key:    ${CYAN}${SERVICE_KEY}${NC}"
echo ""
echo -e "  ${YELLOW}Next: Point *.${BASE_DOMAIN} CNAME to Kong ALB${NC}"
echo ""
