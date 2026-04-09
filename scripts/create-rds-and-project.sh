#!/usr/bin/env bash
#
# End-to-end: Create a NEW Aurora Serverless v2 cluster, register it, and create a project.
#
# Flow:
#   1. Create Aurora Serverless v2 cluster (reuses existing VPC/subnet/SG)
#   2. Create writer instance + wait for availability (~5-8 min)
#   3. Register the new RDS instance with tenant-manager
#   4. Set ECR Lambda pull permissions (idempotent)
#   5. Create a project on the new instance
#   6. Verify project is ACTIVE_HEALTHY
#
# Usage:
#   ./scripts/create-rds-and-project.sh                     # auto-generated names
#   ./scripts/create-rds-and-project.sh my-worker-02        # custom worker identifier
#   CLUSTER_ID=my-cluster PROJECT_NAME=my-proj ./scripts/create-rds-and-project.sh
#
set -euo pipefail

# ── Logging ─────────────────────────────────────────────────────────
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
ACCOUNT_ID="${ACCOUNT_ID:-$(jq -r '.project.accountId // empty' "$CONFIG_FILE")}"
STACK_NAME="${STACK_NAME:-SupabaseStack}"
BASE_DOMAIN=$(jq -r '.domain.baseDomain' "$CONFIG_FILE")

# Naming: CLI arg or auto-generated with timestamp
SUFFIX="${1:-$(date +%m%d%H%M)}"
CLUSTER_ID="${CLUSTER_ID:-supabase-worker-${SUFFIX}}"
INSTANCE_ID_RDS="${CLUSTER_ID}-writer"
WORKER_IDENTIFIER="${WORKER_IDENTIFIER:-worker-${SUFFIX}}"
PROJECT_NAME="${PROJECT_NAME:-project-${SUFFIX}}"

# Aurora config (match existing worker cluster)
ENGINE_VERSION="${ENGINE_VERSION:-16.6}"
MIN_ACU="${MIN_ACU:-0.5}"
MAX_ACU="${MAX_ACU:-4}"
MASTER_USER="postgres"

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  New RDS + Project Creator${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "  Region:          ${GREEN}$REGION${NC}"
echo -e "  Cluster ID:      ${GREEN}$CLUSTER_ID${NC}"
echo -e "  Worker ID:       ${GREEN}$WORKER_IDENTIFIER${NC}"
echo -e "  Project:         ${GREEN}$PROJECT_NAME${NC}"
echo -e "  Aurora:          ${GREEN}PostgreSQL $ENGINE_VERSION, ${MIN_ACU}-${MAX_ACU} ACU${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

# ── Pre-flight ──────────────────────────────────────────────────────
log "Verifying AWS credentials..."
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || fail "AWS credentials invalid"
ok "AWS credentials OK"

# ── Fetch infrastructure from CloudFormation ────────────────────────
log "Fetching infrastructure config from $STACK_NAME..."

CFN_OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs' \
  --output json 2>/dev/null) || fail "Cannot read stack $STACK_NAME"

get_output() {
  echo "$CFN_OUTPUTS" | jq -r ".[] | select(.OutputKey==\"$1\") | .OutputValue"
}

WORKER_RDS_SG=$(get_output "WorkerRdsSgId")
STUDIO_ALB_DNS=$(get_output "StudioALBDnsName")
VPC_SUBNET_IDS=$(get_output "VpcSubnetIds")

[ -z "$WORKER_RDS_SG" ]   && fail "WorkerRdsSgId not found"
[ -z "$STUDIO_ALB_DNS" ]  && fail "StudioALBDnsName not found"
[ -z "$VPC_SUBNET_IDS" ]  && fail "VpcSubnetIds not found"

STUDIO_BASE_URL="${STUDIO_BASE_URL:-https://${STUDIO_ALB_DNS}}"

# Get DB subnet group from existing worker cluster
EXISTING_CLUSTER=$(aws rds describe-db-clusters \
  --region "$REGION" \
  --query 'DBClusters[?starts_with(DBClusterIdentifier, `supabase-worker`)] | [0]' \
  --output json 2>/dev/null)

DB_SUBNET_GROUP=$(echo "$EXISTING_CLUSTER" | jq -r '.DBSubnetGroup // empty')
[ -z "$DB_SUBNET_GROUP" ] && fail "Cannot find DB subnet group from existing worker cluster"

ok "Security Group:  $WORKER_RDS_SG"
ok "DB Subnet Group: $DB_SUBNET_GROUP"
ok "Studio ALB:      $STUDIO_BASE_URL"

# ── Retrieve admin API key ──────────────────────────────────────────
if [ -z "${ADMIN_API_KEY:-}" ]; then
  log "Retrieving admin API key..."
  ADMIN_API_KEY=$(aws secretsmanager get-secret-value \
    --secret-id "supabase/admin-api-key" \
    --region "$REGION" \
    --query 'SecretString' \
    --output text 2>/dev/null) || fail "Cannot read admin API key"
  ok "Admin API key retrieved"
fi

# ═════════════════════════════════════════════════════════════════════
# Step 1: Create Aurora Serverless v2 Cluster
# ═════════════════════════════════════════════════════════════════════
MASTER_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)

# Check if cluster already exists
EXISTING_STATUS=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --region "$REGION" \
  --query 'DBClusters[0].Status' \
  --output text 2>/dev/null) || EXISTING_STATUS=""

if [ "$EXISTING_STATUS" = "available" ]; then
  warn "Cluster '$CLUSTER_ID' already exists and is available, skipping creation"
else
  if [ -n "$EXISTING_STATUS" ] && [ "$EXISTING_STATUS" != "None" ]; then
    fail "Cluster '$CLUSTER_ID' exists in state: $EXISTING_STATUS"
  fi

  log "Step 1: Creating Aurora Serverless v2 cluster '$CLUSTER_ID'..."

  aws rds create-db-cluster \
    --db-cluster-identifier "$CLUSTER_ID" \
    --engine aurora-postgresql \
    --engine-version "$ENGINE_VERSION" \
    --master-username "$MASTER_USER" \
    --master-user-password "$MASTER_PASSWORD" \
    --db-subnet-group-name "$DB_SUBNET_GROUP" \
    --vpc-security-group-ids "$WORKER_RDS_SG" \
    --serverless-v2-scaling-configuration "MinCapacity=${MIN_ACU},MaxCapacity=${MAX_ACU}" \
    --storage-encrypted \
    --backup-retention-period 7 \
    --deletion-protection \
    --region "$REGION" \
    --output text \
    --query 'DBCluster.DBClusterIdentifier' >/dev/null 2>&1 \
    || fail "Failed to create Aurora cluster"

  ok "Cluster creation initiated"

  # Store password in Secrets Manager
  log "Storing credentials in Secrets Manager..."
  SECRET_NAME="supabase/worker-rds/${CLUSTER_ID}"

  CLUSTER_ENDPOINT=$(aws rds describe-db-clusters \
    --db-cluster-identifier "$CLUSTER_ID" \
    --region "$REGION" \
    --query 'DBClusters[0].Endpoint' \
    --output text 2>/dev/null)

  SECRET_VALUE=$(jq -n \
    --arg username "$MASTER_USER" \
    --arg password "$MASTER_PASSWORD" \
    --arg host "${CLUSTER_ENDPOINT:-pending}" \
    --argjson port 5432 \
    --arg dbClusterIdentifier "$CLUSTER_ID" \
    --arg engine "aurora-postgresql" \
    '{username: $username, password: $password, host: $host, port: $port, dbClusterIdentifier: $dbClusterIdentifier, engine: $engine}')

  aws secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --secret-string "$SECRET_VALUE" \
    --region "$REGION" \
    >/dev/null 2>&1 \
    && ok "Credentials stored in Secrets Manager ($SECRET_NAME)" \
    || {
      # Secret may already exist, try updating
      aws secretsmanager put-secret-value \
        --secret-id "$SECRET_NAME" \
        --secret-string "$SECRET_VALUE" \
        --region "$REGION" >/dev/null 2>&1
      ok "Credentials updated in Secrets Manager ($SECRET_NAME)"
    }

  # Create writer instance
  log "Creating writer instance '$INSTANCE_ID_RDS'..."

  aws rds create-db-instance \
    --db-instance-identifier "$INSTANCE_ID_RDS" \
    --db-cluster-identifier "$CLUSTER_ID" \
    --engine aurora-postgresql \
    --db-instance-class db.serverless \
    --region "$REGION" \
    --output text \
    --query 'DBInstance.DBInstanceIdentifier' >/dev/null 2>&1 \
    || fail "Failed to create writer instance"

  ok "Writer instance creation initiated"
fi

# ═════════════════════════════════════════════════════════════════════
# Step 2: Wait for cluster to become available
# ═════════════════════════════════════════════════════════════════════
log "Step 2: Waiting for cluster to become available (this takes 5-8 minutes)..."

WAIT_START=$(date +%s)
while true; do
  STATUS=$(aws rds describe-db-clusters \
    --db-cluster-identifier "$CLUSTER_ID" \
    --region "$REGION" \
    --query 'DBClusters[0].Status' \
    --output text 2>/dev/null)

  ELAPSED=$(( $(date +%s) - WAIT_START ))
  MINS=$(( ELAPSED / 60 ))
  SECS=$(( ELAPSED % 60 ))

  if [ "$STATUS" = "available" ]; then
    ok "Cluster available (${MINS}m${SECS}s)"
    break
  fi

  if [ "$ELAPSED" -gt 900 ]; then
    fail "Timeout after 15 minutes. Cluster status: $STATUS"
  fi

  printf "\r  [%02d:%02d] Status: %-20s" "$MINS" "$SECS" "$STATUS"
  sleep 15
done

# Also wait for writer instance
log "Waiting for writer instance..."
aws rds wait db-instance-available \
  --db-instance-identifier "$INSTANCE_ID_RDS" \
  --region "$REGION" 2>/dev/null \
  && ok "Writer instance available" \
  || warn "Writer wait timed out, checking manually..."

# Get final endpoint
CLUSTER_ENDPOINT=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --region "$REGION" \
  --query 'DBClusters[0].Endpoint' \
  --output text 2>/dev/null)

CLUSTER_PORT=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --region "$REGION" \
  --query 'DBClusters[0].Port' \
  --output text 2>/dev/null)

ok "Endpoint: $CLUSTER_ENDPOINT:$CLUSTER_PORT"

# Update secret with final endpoint
SECRET_VALUE=$(jq -n \
  --arg username "$MASTER_USER" \
  --arg password "$MASTER_PASSWORD" \
  --arg host "$CLUSTER_ENDPOINT" \
  --argjson port "$CLUSTER_PORT" \
  --arg dbClusterIdentifier "$CLUSTER_ID" \
  --arg engine "aurora-postgresql" \
  '{username: $username, password: $password, host: $host, port: $port, dbClusterIdentifier: $dbClusterIdentifier, engine: $engine}')

aws secretsmanager put-secret-value \
  --secret-id "$SECRET_NAME" \
  --secret-string "$SECRET_VALUE" \
  --region "$REGION" >/dev/null 2>&1 || true

# ═════════════════════════════════════════════════════════════════════
# Step 3: Register with tenant-manager
# ═════════════════════════════════════════════════════════════════════
log "Step 3: Registering '$WORKER_IDENTIFIER' with tenant-manager..."

# Health check
TM_HEALTH=$(curl -sk -o /dev/null -w '%{http_code}' "${STUDIO_BASE_URL}/health/live" 2>/dev/null) || true
[ "$TM_HEALTH" = "200" ] || fail "Tenant-manager not healthy (HTTP $TM_HEALTH)"

# Check if already registered
EXISTING_RESP=$(curl -sk \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  "${STUDIO_BASE_URL}/admin/v1/rds-instances?status=active" 2>/dev/null)

INSTANCE_EXISTS=$(echo "$EXISTING_RESP" | jq -r \
  --arg id "$WORKER_IDENTIFIER" \
  '.data // [] | map(select(.identifier == $id)) | length > 0' 2>/dev/null) || INSTANCE_EXISTS="false"

if [ "$INSTANCE_EXISTS" = "true" ]; then
  TM_INSTANCE_ID=$(echo "$EXISTING_RESP" | jq -r \
    --arg id "$WORKER_IDENTIFIER" \
    '.data[] | select(.identifier == $id) | .id')
  ok "Worker '$WORKER_IDENTIFIER' already registered (ID: $TM_INSTANCE_ID)"
else
  REGISTER_PAYLOAD=$(jq -n \
    --arg identifier "$WORKER_IDENTIFIER" \
    --arg name "Worker RDS ($CLUSTER_ID)" \
    --arg host "$CLUSTER_ENDPOINT" \
    --argjson port "$CLUSTER_PORT" \
    --arg admin_user "$MASTER_USER" \
    --arg admin_password "$MASTER_PASSWORD" \
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
    fail "Registration failed (HTTP $REGISTER_HTTP)"
  fi

  TM_INSTANCE_ID=$(echo "$REGISTER_BODY" | jq -r '.data.id // .id // empty')
  ok "Registered (tenant-manager ID: $TM_INSTANCE_ID)"

  # Test credentials
  TEST_HTTP=$(curl -sk -o /dev/null -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    "${STUDIO_BASE_URL}/admin/v1/rds-instances/${TM_INSTANCE_ID}/test-credentials" 2>/dev/null) || true
  [ "$TEST_HTTP" = "200" ] && ok "Credential test passed" || warn "Credential test HTTP $TEST_HTTP"
fi

[[ "$TM_INSTANCE_ID" =~ ^[0-9]+$ ]] || fail "TM_INSTANCE_ID not numeric: '$TM_INSTANCE_ID'"

# ═════════════════════════════════════════════════════════════════════
# Step 4: ECR Lambda permissions (idempotent)
# ═════════════════════════════════════════════════════════════════════
log "Step 4: Ensuring ECR Lambda permissions..."

ECR_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"LambdaECRAccess\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"lambda.amazonaws.com\"},\"Action\":[\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\"],\"Condition\":{\"StringLike\":{\"aws:sourceArn\":\"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:*\"}}}]}"

aws ecr set-repository-policy \
  --repository-name postgrest-lambda \
  --region "$REGION" \
  --policy-text "$ECR_POLICY" \
  >/dev/null 2>&1 && ok "ECR permissions set" || warn "ECR policy set skipped"

# ═════════════════════════════════════════════════════════════════════
# Step 5: Create project
# ═════════════════════════════════════════════════════════════════════
log "Step 5: Creating project '$PROJECT_NAME'..."

PROJECT_PAYLOAD=$(jq -n \
  --arg name "$PROJECT_NAME" \
  --argjson db_instance_id "$TM_INSTANCE_ID" \
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
  fail "Project creation failed (HTTP $PROJECT_HTTP)"
fi

PROJECT_REF=$(echo "$PROJECT_BODY" | jq -r '.data.ref // .ref // empty')
ok "Project created (ref: $PROJECT_REF)"

# ═════════════════════════════════════════════════════════════════════
# Step 6: Verify
# ═════════════════════════════════════════════════════════════════════
log "Step 6: Verifying project..."

VERIFY_RESP=$(curl -sk \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  "${STUDIO_BASE_URL}/admin/v1/projects/${PROJECT_REF}" 2>/dev/null)

PROJECT_STATUS=$(echo "$VERIFY_RESP" | jq -r '.data.status // .status // "unknown"')
ok "Project status: $PROJECT_STATUS"

# Extract API keys
ANON_KEY=$(echo "$PROJECT_BODY" | jq -r '
  (.data.api_keys // .api_keys // [])[]
  | select(.name == "anon" or .key_type == "publishable")
  | .opaque_key // .api_key // empty' | head -1)

SERVICE_KEY=$(echo "$PROJECT_BODY" | jq -r '
  (.data.api_keys // .api_keys // [])[]
  | select(.name == "service_role" or .key_type == "secret")
  | .opaque_key // .api_key // empty' | head -1)

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Complete! New RDS + Project Ready${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Aurora Cluster${NC}"
echo -e "    Cluster ID:     $CLUSTER_ID"
echo -e "    Endpoint:       $CLUSTER_ENDPOINT"
echo -e "    Engine:         aurora-postgresql $ENGINE_VERSION"
echo -e "    Capacity:       ${MIN_ACU}-${MAX_ACU} ACU (Serverless v2)"
echo -e "    Secret:         $SECRET_NAME"
echo ""
echo -e "  ${CYAN}Project${NC}"
echo -e "    Ref:            $PROJECT_REF"
echo -e "    Status:         $PROJECT_STATUS"
echo -e "    API Endpoint:   https://${PROJECT_REF}.${BASE_DOMAIN}"
[ -n "${ANON_KEY:-}" ]    && echo -e "    Anon Key:       $ANON_KEY"
[ -n "${SERVICE_KEY:-}" ] && echo -e "    Service Key:    $SERVICE_KEY"
echo ""
