#!/usr/bin/env bash
#
# End-to-end: Create a NEW Aurora Serverless v2 cluster, register it, and create a project.
#
# Flow:
#   1. Discover VPC and networking
#   2. Create/reuse parameter groups (cluster PG + DB PG)
#   3. Create/reuse security group with ingress rules
#   4. Create Aurora Serverless v2 cluster (IO/Optimized) + Writer instance
#   5. Create Reader Replicas (prod only)
#   6. Store credentials in Secrets Manager
#   7. Enable Performance Insights / Database Insights
#   8. Register the new RDS instance with tenant-manager
#   9. Verify registration success
#  10. Set ECR Lambda pull permissions (idempotent)
#  11. Create a project on the new instance
#  12. Verify project is ACTIVE_HEALTHY
#
# Usage:
#   ./scripts/create-rds-and-project.sh                           # auto-generated names, test env
#   ./scripts/create-rds-and-project.sh my-worker-02              # custom worker identifier
#   ENV=prod ./scripts/create-rds-and-project.sh                  # production environment
#   DRY_RUN=1 ./scripts/create-rds-and-project.sh                 # dry-run mode
#   CLUSTER_ID=my-cluster PROJECT_NAME=my-proj ./scripts/create-rds-and-project.sh
#
#   # Reuse existing parameter groups and security group:
#   CLUSTER_PG=existing-cluster-pg DB_PG=existing-db-pg WORKER_SG=sg-xxx ./scripts/create-rds-and-project.sh
#
#   # Provide source SGs for ingress rules (when creating new SG):
#   TM_SG=sg-aaa LAMBDA_SG=sg-bbb PG_META_SG=sg-ccc AUTH_SG=sg-ddd ./scripts/create-rds-and-project.sh
#
set -euo pipefail

# ── Logging ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()   { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# Dry-run wrapper: skip actual execution when DRY_RUN=1
run() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    log "[DRY-RUN] $*"
    return 0
  fi
  "$@"
}

# ── Configuration ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/../config.json"

[ -f "$CONFIG_FILE" ] || fail "config.json not found at $CONFIG_FILE"
command -v aws  >/dev/null 2>&1 || fail "aws CLI not found"
command -v jq   >/dev/null 2>&1 || fail "jq not found"
command -v curl >/dev/null 2>&1 || fail "curl not found"

DRY_RUN="${DRY_RUN:-0}"

# ── Environment differentiation ────────────────────────────────────
ENV="${ENV:-test}"
case "$ENV" in
  prod)
    MIN_ACU="${MIN_ACU:-2}"
    MAX_ACU="${MAX_ACU:-16}"
    READER_COUNT="${READER_COUNT:-1}"
    DELETION_PROTECTION="${DELETION_PROTECTION:-true}"
    BACKUP_RETENTION="${BACKUP_RETENTION:-30}"
    ;;
  test|*)
    MIN_ACU="${MIN_ACU:-0.5}"
    MAX_ACU="${MAX_ACU:-4}"
    READER_COUNT="${READER_COUNT:-0}"
    DELETION_PROTECTION="${DELETION_PROTECTION:-false}"
    BACKUP_RETENTION="${BACKUP_RETENTION:-7}"
    ;;
esac

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

# Aurora config
ENGINE_VERSION="${ENGINE_VERSION:-16.8}"
MASTER_USER="postgres"
DB_PORT="${DB_PORT:-5432}"

# Parameter group reuse (set to existing name to skip creation)
CLUSTER_PG="${CLUSTER_PG:-}"
DB_PG="${DB_PG:-}"

# Security group reuse (set to existing SG ID to skip creation)
WORKER_SG="${WORKER_SG:-}"

# Source SGs for ingress rules (used when creating new SG)
TM_SG="${TM_SG:-}"
LAMBDA_SG="${LAMBDA_SG:-}"
PG_META_SG="${PG_META_SG:-}"
AUTH_SG="${AUTH_SG:-}"

# VPC (auto-discovered if empty)
VPC_ID="${VPC_ID:-}"
SUBNET_GROUP="${SUBNET_GROUP:-supabase-rds-subnet-group}"

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  New RDS + Project Creator${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "  Environment:     ${GREEN}$ENV${NC}"
echo -e "  Region:          ${GREEN}$REGION${NC}"
echo -e "  Cluster ID:      ${GREEN}$CLUSTER_ID${NC}"
echo -e "  Worker ID:       ${GREEN}$WORKER_IDENTIFIER${NC}"
echo -e "  Project:         ${GREEN}$PROJECT_NAME${NC}"
echo -e "  Aurora:          ${GREEN}PostgreSQL $ENGINE_VERSION, ${MIN_ACU}-${MAX_ACU} ACU (IO/Optimized)${NC}"
echo -e "  Readers:         ${GREEN}$READER_COUNT${NC}"
echo -e "  Delete protect:  ${GREEN}$DELETION_PROTECTION${NC}"
echo -e "  Backup retention:${GREEN}${BACKUP_RETENTION} days${NC}"
echo -e "  Dry-Run:         ${GREEN}$DRY_RUN${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

# ── Pre-flight ──────────────────────────────────────────────────────
log "Verifying AWS credentials..."
if [ "$DRY_RUN" != "1" ]; then
  aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || fail "AWS credentials invalid"
fi
ok "AWS credentials OK"

# ── Password generation ─────────────────────────────────────────────
MASTER_PASSWORD="${MASTER_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)}"

# ═════════════════════════════════════════════════════════════════════
# Step 1: Discover VPC and networking
# ═════════════════════════════════════════════════════════════════════
log "Step 1: Discovering VPC and networking..."

if [ -z "$VPC_ID" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    VPC_ID="vpc-dry-run"
  else
    log "Auto-discovering VPC by tag 'supabase'..."
    VPC_ID=$(aws ec2 describe-vpcs \
      --filters "Name=tag:Name,Values=*supabase*" \
      --query 'Vpcs[0].VpcId' \
      --output text \
      --region "$REGION" 2>/dev/null) || VPC_ID=""

    if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
      # Fallback: try CloudFormation outputs
      log "VPC tag discovery failed, trying CloudFormation stack..."
      CFN_OUTPUTS=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'Stacks[0].Outputs' \
        --output json 2>/dev/null) || CFN_OUTPUTS="[]"

      VPC_ID=$(echo "$CFN_OUTPUTS" | jq -r '.[] | select(.OutputKey=="VpcId") | .OutputValue' 2>/dev/null) || VPC_ID=""
      [ -z "$VPC_ID" ] || [ "$VPC_ID" = "null" ] && fail "Cannot discover VPC. Please specify VPC_ID manually"
    fi
  fi
fi
ok "VPC: $VPC_ID"

# Fetch CloudFormation outputs for ALB DNS and other infra
if [ "$DRY_RUN" != "1" ]; then
  CFN_OUTPUTS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query 'Stacks[0].Outputs' \
    --output json 2>/dev/null) || CFN_OUTPUTS="[]"

  get_output() {
    echo "$CFN_OUTPUTS" | jq -r ".[] | select(.OutputKey==\"$1\") | .OutputValue"
  }

  STUDIO_ALB_DNS=$(get_output "StudioALBDnsName")
  [ -z "$STUDIO_ALB_DNS" ] && fail "StudioALBDnsName not found in stack outputs"
else
  STUDIO_ALB_DNS="dry-run-alb.example.com"
fi

STUDIO_BASE_URL="${STUDIO_BASE_URL:-https://${STUDIO_ALB_DNS}}"
ok "Studio ALB: $STUDIO_BASE_URL"

# Discover or validate DB subnet group
if [ "$DRY_RUN" != "1" ]; then
  # Try to use the specified subnet group, or discover from existing cluster
  aws rds describe-db-subnet-groups \
    --db-subnet-group-name "$SUBNET_GROUP" \
    --region "$REGION" >/dev/null 2>&1 || {
    log "Subnet group '$SUBNET_GROUP' not found, discovering from existing worker cluster..."
    EXISTING_CLUSTER=$(aws rds describe-db-clusters \
      --region "$REGION" \
      --query 'DBClusters[?starts_with(DBClusterIdentifier, `supabase-worker`)] | [0]' \
      --output json 2>/dev/null) || EXISTING_CLUSTER="{}"

    SUBNET_GROUP=$(echo "$EXISTING_CLUSTER" | jq -r '.DBSubnetGroup // empty')
    [ -z "$SUBNET_GROUP" ] && fail "Cannot find DB subnet group"
  }
fi
ok "DB Subnet Group: $SUBNET_GROUP"

# ── Retrieve admin API key ──────────────────────────────────────────
if [ -z "${ADMIN_API_KEY:-}" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    ADMIN_API_KEY="dry-run-api-key"
  else
    log "Retrieving admin API key..."
    ADMIN_API_KEY=$(aws secretsmanager get-secret-value \
      --secret-id "supabase/admin-api-key" \
      --region "$REGION" \
      --query 'SecretString' \
      --output text 2>/dev/null) || fail "Cannot read admin API key"
    ok "Admin API key retrieved"
  fi
fi

# ═════════════════════════════════════════════════════════════════════
# Step 2: Create/reuse parameter groups
# ═════════════════════════════════════════════════════════════════════
log "Step 2: Create/reuse parameter groups..."

PG_FAMILY="aurora-postgresql${ENGINE_VERSION%%.*}"

# --- Cluster parameter group ---
if [ -n "$CLUSTER_PG" ]; then
  log "Reusing existing cluster parameter group: $CLUSTER_PG"
else
  CLUSTER_PG="${CLUSTER_ID}-cluster-pg"

  PG_EXISTS="false"
  if [ "$DRY_RUN" != "1" ]; then
    aws rds describe-db-cluster-parameter-groups \
      --db-cluster-parameter-group-name "$CLUSTER_PG" \
      --region "$REGION" >/dev/null 2>&1 && PG_EXISTS="true" || true
  fi

  if [ "$PG_EXISTS" = "true" ]; then
    log "Cluster parameter group already exists: $CLUSTER_PG, updating parameters..."
  else
    log "Creating cluster parameter group: $CLUSTER_PG"
    run aws rds create-db-cluster-parameter-group \
      --db-cluster-parameter-group-name "$CLUSTER_PG" \
      --db-parameter-group-family "$PG_FAMILY" \
      --description "Cluster PG for Supabase Aurora cluster $CLUSTER_ID" \
      --region "$REGION" \
      --output text >/dev/null 2>&1 \
      || warn "Cluster PG creation failed (may already exist)"
  fi

  log "Setting cluster parameters (shared_preload_libraries, logical_replication, max_slot_wal_keep_size)..."
  run aws rds modify-db-cluster-parameter-group \
    --db-cluster-parameter-group-name "$CLUSTER_PG" \
    --parameters \
      "ParameterName=shared_preload_libraries,ParameterValue='pg_stat_statements,pg_cron',ApplyMethod=pending-reboot" \
      "ParameterName=rds.logical_replication,ParameterValue=1,ApplyMethod=pending-reboot" \
      "ParameterName=max_slot_wal_keep_size,ParameterValue=1024,ApplyMethod=immediate" \
    --region "$REGION" \
    --output text >/dev/null 2>&1 \
    || warn "Cluster PG modify failed"
fi
ok "Cluster PG: $CLUSTER_PG"

# --- DB instance parameter group ---
if [ -n "$DB_PG" ]; then
  log "Reusing existing DB parameter group: $DB_PG"
else
  DB_PG="${CLUSTER_ID}-db-pg"

  PG_EXISTS="false"
  if [ "$DRY_RUN" != "1" ]; then
    aws rds describe-db-parameter-groups \
      --db-parameter-group-name "$DB_PG" \
      --region "$REGION" >/dev/null 2>&1 && PG_EXISTS="true" || true
  fi

  if [ "$PG_EXISTS" = "true" ]; then
    log "DB parameter group already exists: $DB_PG, updating parameters..."
  else
    log "Creating DB parameter group: $DB_PG"
    run aws rds create-db-parameter-group \
      --db-parameter-group-name "$DB_PG" \
      --db-parameter-group-family "$PG_FAMILY" \
      --description "DB PG for Supabase Aurora instances in $CLUSTER_ID" \
      --region "$REGION" \
      --output text >/dev/null 2>&1 \
      || warn "DB PG creation failed (may already exist)"
  fi

  log "Setting instance parameters (log_min_duration_statement, auto_explain)..."
  run aws rds modify-db-parameter-group \
    --db-parameter-group-name "$DB_PG" \
    --parameters \
      "ParameterName=log_min_duration_statement,ParameterValue=1000,ApplyMethod=immediate" \
      "ParameterName=auto_explain.log_min_duration,ParameterValue=1000,ApplyMethod=immediate" \
    --region "$REGION" \
    --output text >/dev/null 2>&1 \
    || warn "DB PG modify failed"
fi
ok "DB PG: $DB_PG"

# ═════════════════════════════════════════════════════════════════════
# Step 3: Create/reuse security group with ingress rules
# ═════════════════════════════════════════════════════════════════════
log "Step 3: Create/reuse security group..."

if [ -n "$WORKER_SG" ]; then
  log "Reusing existing security group: $WORKER_SG"
  WORKER_RDS_SG="$WORKER_SG"
else
  SG_NAME="${CLUSTER_ID}-sg"
  WORKER_RDS_SG=""

  # Auto-discover source SGs if not provided
  if [ "$DRY_RUN" != "1" ] && { [ -z "$TM_SG" ] || [ -z "$LAMBDA_SG" ] || [ -z "$PG_META_SG" ] || [ -z "$AUTH_SG" ]; }; then
    log "Auto-discovering service security groups from VPC..."
    ALL_SGS=$(aws ec2 describe-security-groups \
      --filters "Name=vpc-id,Values=$VPC_ID" \
      --query 'SecurityGroups[*].{ID:GroupId,Name:GroupName}' \
      --output json \
      --region "$REGION" 2>/dev/null) || ALL_SGS="[]"

    find_sg_by_keyword() {
      local keywords="$1"
      echo "$ALL_SGS" | jq -r --arg kws "$keywords" '
        ($kws | split(",")) as $kwlist |
        .[] | select(.Name != null) |
        select(.Name | ascii_downcase | . as $n | $kwlist | any(. as $kw | $n | contains($kw))) |
        .ID' | head -1
    }

    [ -z "$TM_SG" ] && TM_SG=$(find_sg_by_keyword "tenantmanagersg,tenant-manager,tenantmanager") && [ -n "$TM_SG" ] && log "  Discovered Tenant Manager SG: $TM_SG"
    [ -z "$LAMBDA_SG" ] && LAMBDA_SG=$(find_sg_by_keyword "lambdasg,lambda-sg") && [ -n "$LAMBDA_SG" ] && log "  Discovered Lambda SG: $LAMBDA_SG"
    [ -z "$PG_META_SG" ] && PG_META_SG=$(find_sg_by_keyword "postgresmetasg,postgres-meta,pg-meta,pgmeta") && [ -n "$PG_META_SG" ] && log "  Discovered postgres-meta SG: $PG_META_SG"
    [ -z "$AUTH_SG" ] && AUTH_SG=$(find_sg_by_keyword "authsg,auth-sg,auth-service,gotrue") && [ -n "$AUTH_SG" ] && log "  Discovered Auth SG: $AUTH_SG"
  fi

  # Check if SG already exists
  if [ "$DRY_RUN" != "1" ]; then
    WORKER_RDS_SG=$(aws ec2 describe-security-groups \
      --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
      --query 'SecurityGroups[0].GroupId' \
      --output text \
      --region "$REGION" 2>/dev/null) || WORKER_RDS_SG=""
    [ "$WORKER_RDS_SG" = "None" ] && WORKER_RDS_SG=""
  fi

  if [ -n "$WORKER_RDS_SG" ]; then
    log "Security group already exists: $WORKER_RDS_SG, reusing"
  else
    log "Creating security group: $SG_NAME"
    if [ "$DRY_RUN" = "1" ]; then
      WORKER_RDS_SG="sg-dry-run"
    else
      WORKER_RDS_SG=$(aws ec2 create-security-group \
        --group-name "$SG_NAME" \
        --description "SG for Supabase Aurora cluster $CLUSTER_ID" \
        --vpc-id "$VPC_ID" \
        --query 'GroupId' \
        --output text \
        --region "$REGION" 2>/dev/null) || fail "Failed to create security group"
    fi
    ok "Security group created: $WORKER_RDS_SG"
  fi

  # Add ingress rules from source SGs
  add_ingress() {
    local name="$1" sg_id="$2"
    [ -z "$sg_id" ] && { warn "Skipping $name ingress rule (no SG ID)"; return 0; }
    log "Adding ingress rule: $name ($sg_id) -> port $DB_PORT"
    run aws ec2 authorize-security-group-ingress \
      --group-id "$WORKER_RDS_SG" \
      --protocol tcp \
      --port "$DB_PORT" \
      --source-group "$sg_id" \
      --region "$REGION" >/dev/null 2>&1 \
      || log "  Ingress rule already exists or failed: $name"
  }

  add_ingress "Tenant Manager" "$TM_SG"
  add_ingress "Lambda" "$LAMBDA_SG"
  add_ingress "postgres-meta" "$PG_META_SG"
  add_ingress "Auth" "$AUTH_SG"
fi
ok "Security Group: $WORKER_RDS_SG"

# ═════════════════════════════════════════════════════════════════════
# Step 4: Create Aurora Serverless v2 Cluster (IO/Optimized)
# ═════════════════════════════════════════════════════════════════════

# Check if cluster already exists
EXISTING_STATUS=""
if [ "$DRY_RUN" != "1" ]; then
  EXISTING_STATUS=$(aws rds describe-db-clusters \
    --db-cluster-identifier "$CLUSTER_ID" \
    --region "$REGION" \
    --query 'DBClusters[0].Status' \
    --output text 2>/dev/null) || EXISTING_STATUS=""
fi

if [ "$EXISTING_STATUS" = "available" ]; then
  warn "Cluster '$CLUSTER_ID' already exists and is available, skipping creation"
else
  if [ -n "$EXISTING_STATUS" ] && [ "$EXISTING_STATUS" != "None" ] && [ "$EXISTING_STATUS" != "" ]; then
    fail "Cluster '$CLUSTER_ID' exists in state: $EXISTING_STATUS"
  fi

  log "Step 4: Creating Aurora Serverless v2 cluster '$CLUSTER_ID' (IO/Optimized)..."

  CREATE_ARGS=(
    rds create-db-cluster
    --db-cluster-identifier "$CLUSTER_ID"
    --engine aurora-postgresql
    --engine-version "$ENGINE_VERSION"
    --master-username "$MASTER_USER"
    --master-user-password "$MASTER_PASSWORD"
    --db-subnet-group-name "$SUBNET_GROUP"
    --vpc-security-group-ids "$WORKER_RDS_SG"
    --db-cluster-parameter-group-name "$CLUSTER_PG"
    --storage-type aurora-iopt1
    --storage-encrypted
    --serverless-v2-scaling-configuration "MinCapacity=${MIN_ACU},MaxCapacity=${MAX_ACU}"
    --backup-retention-period "$BACKUP_RETENTION"
    --database-name postgres
    --region "$REGION"
    --output text
    --query 'DBCluster.DBClusterIdentifier'
  )

  if [ "$DELETION_PROTECTION" = "true" ]; then
    CREATE_ARGS+=(--deletion-protection)
  fi

  run aws "${CREATE_ARGS[@]}" >/dev/null 2>&1 \
    || fail "Failed to create Aurora cluster"

  ok "Cluster creation initiated"

  # Store password in Secrets Manager
  log "Storing credentials in Secrets Manager..."
  SECRET_NAME="supabase/${CLUSTER_ID}/credentials"

  CLUSTER_ENDPOINT="pending"
  if [ "$DRY_RUN" != "1" ]; then
    CLUSTER_ENDPOINT=$(aws rds describe-db-clusters \
      --db-cluster-identifier "$CLUSTER_ID" \
      --region "$REGION" \
      --query 'DBClusters[0].Endpoint' \
      --output text 2>/dev/null) || CLUSTER_ENDPOINT="pending"
  fi

  SECRET_VALUE=$(jq -n \
    --arg username "$MASTER_USER" \
    --arg password "$MASTER_PASSWORD" \
    --arg host "$CLUSTER_ENDPOINT" \
    --argjson port "$DB_PORT" \
    --arg dbClusterIdentifier "$CLUSTER_ID" \
    --arg engine "aurora-postgresql" \
    '{username: $username, password: $password, host: $host, port: $port, dbClusterIdentifier: $dbClusterIdentifier, engine: $engine}')

  run aws secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --description "Credentials for Supabase Aurora cluster $CLUSTER_ID" \
    --secret-string "$SECRET_VALUE" \
    --region "$REGION" \
    >/dev/null 2>&1 \
    && ok "Credentials stored in Secrets Manager ($SECRET_NAME)" \
    || {
      run aws secretsmanager put-secret-value \
        --secret-id "$SECRET_NAME" \
        --secret-string "$SECRET_VALUE" \
        --region "$REGION" >/dev/null 2>&1
      ok "Credentials updated in Secrets Manager ($SECRET_NAME)"
    }

  # Create writer instance with DB parameter group
  log "Creating writer instance '$INSTANCE_ID_RDS'..."

  run aws rds create-db-instance \
    --db-instance-identifier "$INSTANCE_ID_RDS" \
    --db-cluster-identifier "$CLUSTER_ID" \
    --engine aurora-postgresql \
    --db-instance-class db.serverless \
    --db-parameter-group-name "$DB_PG" \
    --region "$REGION" \
    --output text \
    --query 'DBInstance.DBInstanceIdentifier' >/dev/null 2>&1 \
    || fail "Failed to create writer instance"

  ok "Writer instance creation initiated"
fi

# ═════════════════════════════════════════════════════════════════════
# Step 5: Wait for cluster + writer to become available
# ═════════════════════════════════════════════════════════════════════
if [ "$DRY_RUN" != "1" ]; then
  log "Step 5: Waiting for cluster to become available (this takes 5-10 minutes)..."

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

  # Wait for writer instance
  log "Waiting for writer instance..."
  aws rds wait db-instance-available \
    --db-instance-identifier "$INSTANCE_ID_RDS" \
    --region "$REGION" 2>/dev/null \
    && ok "Writer instance available" \
    || warn "Writer wait timed out, checking manually..."
else
  log "[DRY-RUN] Skipping wait for cluster availability"
fi

# Get final endpoints
if [ "$DRY_RUN" != "1" ]; then
  CLUSTER_ENDPOINT=$(aws rds describe-db-clusters \
    --db-cluster-identifier "$CLUSTER_ID" \
    --region "$REGION" \
    --query 'DBClusters[0].Endpoint' \
    --output text 2>/dev/null)

  READER_ENDPOINT=$(aws rds describe-db-clusters \
    --db-cluster-identifier "$CLUSTER_ID" \
    --region "$REGION" \
    --query 'DBClusters[0].ReaderEndpoint' \
    --output text 2>/dev/null)

  CLUSTER_PORT=$(aws rds describe-db-clusters \
    --db-cluster-identifier "$CLUSTER_ID" \
    --region "$REGION" \
    --query 'DBClusters[0].Port' \
    --output text 2>/dev/null)
else
  CLUSTER_ENDPOINT="dry-run-endpoint.cluster-xxx.rds.amazonaws.com"
  READER_ENDPOINT="dry-run-endpoint.cluster-ro-xxx.rds.amazonaws.com"
  CLUSTER_PORT="$DB_PORT"
fi

ok "Writer endpoint: $CLUSTER_ENDPOINT:$CLUSTER_PORT"
ok "Reader endpoint: $READER_ENDPOINT"

# Update secret with final endpoint
SECRET_NAME="${SECRET_NAME:-supabase/${CLUSTER_ID}/credentials}"
SECRET_VALUE=$(jq -n \
  --arg username "$MASTER_USER" \
  --arg password "$MASTER_PASSWORD" \
  --arg host "$CLUSTER_ENDPOINT" \
  --arg reader_host "$READER_ENDPOINT" \
  --argjson port "$CLUSTER_PORT" \
  --arg dbClusterIdentifier "$CLUSTER_ID" \
  --arg engine "aurora-postgresql" \
  '{username: $username, password: $password, engine: $engine, host: $host, reader_host: $reader_host, port: $port, dbClusterIdentifier: $dbClusterIdentifier}')

run aws secretsmanager put-secret-value \
  --secret-id "$SECRET_NAME" \
  --secret-string "$SECRET_VALUE" \
  --region "$REGION" >/dev/null 2>&1 || true

# Verify stored credentials
if [ "$DRY_RUN" != "1" ]; then
  log "Verifying stored credentials..."
  STORED_HOST=$(aws secretsmanager get-secret-value \
    --secret-id "$SECRET_NAME" \
    --region "$REGION" \
    --query 'SecretString' \
    --output text 2>/dev/null | jq -r '.host')
  [ "$STORED_HOST" = "$CLUSTER_ENDPOINT" ] && ok "Credentials verification passed" || warn "Credentials host mismatch"
fi

# ═════════════════════════════════════════════════════════════════════
# Step 6: Enable Performance Insights / Database Insights
# ═════════════════════════════════════════════════════════════════════
log "Step 6: Enabling Database Insights..."

run aws rds modify-db-cluster \
  --db-cluster-identifier "$CLUSTER_ID" \
  --enable-performance-insights \
  --database-insights-mode standard \
  --performance-insights-retention-period 31 \
  --apply-immediately \
  --region "$REGION" \
  --output text >/dev/null 2>&1 \
  && ok "Database Insights enabled (31-day retention)" \
  || warn "Database Insights enable failed (may not be supported)"

# ═════════════════════════════════════════════════════════════════════
# Step 7: Create Reader Replicas (prod only)
# ═════════════════════════════════════════════════════════════════════
log "Step 7: Create Reader Replicas..."

if [ "$READER_COUNT" -le 0 ]; then
  log "Reader count is 0, skipping Reader creation"
else
  for i in $(seq 1 "$READER_COUNT"); do
    READER_ID="${CLUSTER_ID}-reader-${i}"
    log "Creating Reader $i: $READER_ID"

    run aws rds create-db-instance \
      --db-instance-identifier "$READER_ID" \
      --db-instance-class db.serverless \
      --engine aurora-postgresql \
      --db-cluster-identifier "$CLUSTER_ID" \
      --db-parameter-group-name "$DB_PG" \
      --region "$REGION" \
      --output text >/dev/null 2>&1 \
      || { warn "Reader $READER_ID creation failed (may already exist)"; continue; }

    if [ "$DRY_RUN" != "1" ]; then
      log "Waiting for Reader $i to become available..."
      aws rds wait db-instance-available \
        --db-instance-identifier "$READER_ID" \
        --region "$REGION" 2>/dev/null \
        && ok "Reader $i available" \
        || warn "Reader $i wait timed out"
    fi
  done

  # Verify cluster members
  if [ "$DRY_RUN" != "1" ]; then
    log "Cluster members:"
    aws rds describe-db-clusters \
      --db-cluster-identifier "$CLUSTER_ID" \
      --query 'DBClusters[0].DBClusterMembers[*].{ID:DBInstanceIdentifier,IsWriter:IsClusterWriter}' \
      --output table \
      --region "$REGION" 2>/dev/null || true
  fi
fi

# ═════════════════════════════════════════════════════════════════════
# Step 8: Register with tenant-manager
# ═════════════════════════════════════════════════════════════════════
log "Step 8: Registering '$WORKER_IDENTIFIER' with tenant-manager..."

if [ "$DRY_RUN" = "1" ]; then
  log "[DRY-RUN] Skipping tenant-manager registration"
  TM_INSTANCE_ID="0"
else
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
      --arg name "Aurora Cluster ($CLUSTER_ID, IO/Optimized, PG $ENGINE_VERSION)" \
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
      # Print troubleshooting help
      case "$REGISTER_HTTP" in
        400) warn "Check that the request body contains all required fields" ;;
        401) warn "Invalid API Key. Re-fetch from Secrets Manager: supabase/admin-api-key" ;;
        409) warn "Identifier already exists. Use a different identifier or delete the existing instance first" ;;
        500) warn "Server error. Check Tenant Manager logs" ;;
      esac
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
fi

[[ "${TM_INSTANCE_ID:-}" =~ ^[0-9]+$ ]] || fail "TM_INSTANCE_ID not numeric: '$TM_INSTANCE_ID'"

# ═════════════════════════════════════════════════════════════════════
# Step 9: Verify registration
# ═════════════════════════════════════════════════════════════════════
log "Step 9: Verifying registration..."

if [ "$DRY_RUN" = "1" ]; then
  log "[DRY-RUN] Skipping registration verification"
else
  VERIFY_REG_RESP=$(curl -sk \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    "${STUDIO_BASE_URL}/admin/v1/rds-instances/${TM_INSTANCE_ID}" 2>/dev/null)

  REG_STATUS=$(echo "$VERIFY_REG_RESP" | jq -r '.data.status // .status // "unknown"' 2>/dev/null)
  REG_IDENTIFIER=$(echo "$VERIFY_REG_RESP" | jq -r '.data.identifier // .identifier // "unknown"' 2>/dev/null)
  REG_HOST=$(echo "$VERIFY_REG_RESP" | jq -r '.data.host // .host // "unknown"' 2>/dev/null)
  REG_MAX_DB=$(echo "$VERIFY_REG_RESP" | jq -r '.data.max_databases // .max_databases // "unknown"' 2>/dev/null)

  ok "Registration verified:"
  echo -e "    Instance ID:    $TM_INSTANCE_ID"
  echo -e "    Identifier:     $REG_IDENTIFIER"
  echo -e "    Status:         $REG_STATUS"
  echo -e "    Host:           $REG_HOST"
  echo -e "    Max databases:  $REG_MAX_DB"
fi

# ═════════════════════════════════════════════════════════════════════
# Step 10: ECR Lambda permissions (idempotent)
# ═════════════════════════════════════════════════════════════════════
log "Step 10: Ensuring ECR Lambda permissions..."

ECR_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"LambdaECRAccess\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"lambda.amazonaws.com\"},\"Action\":[\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\"],\"Condition\":{\"StringLike\":{\"aws:sourceArn\":\"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:*\"}}}]}"

run aws ecr set-repository-policy \
  --repository-name postgrest-lambda \
  --region "$REGION" \
  --policy-text "$ECR_POLICY" \
  >/dev/null 2>&1 && ok "ECR permissions set" || warn "ECR policy set skipped"

# ═════════════════════════════════════════════════════════════════════
# Step 11: Create project
# ═════════════════════════════════════════════════════════════════════
log "Step 11: Creating project '$PROJECT_NAME'..."

if [ "$DRY_RUN" = "1" ]; then
  log "[DRY-RUN] Skipping project creation"
  PROJECT_REF="dry-run-ref"
  PROJECT_STATUS="dry-run"
  PROJECT_BODY="{}"
else
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
fi

# ═════════════════════════════════════════════════════════════════════
# Step 12: Verify project
# ═════════════════════════════════════════════════════════════════════
log "Step 12: Verifying project..."

if [ "$DRY_RUN" != "1" ]; then
  VERIFY_RESP=$(curl -sk \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    "${STUDIO_BASE_URL}/admin/v1/projects/${PROJECT_REF}" 2>/dev/null)

  PROJECT_STATUS=$(echo "$VERIFY_RESP" | jq -r '.data.status // .status // "unknown"')
  ok "Project status: $PROJECT_STATUS"
fi

# Extract API keys
ANON_KEY=$(echo "$PROJECT_BODY" | jq -r '
  (.data.api_keys // .api_keys // [])[]
  | select(.name == "anon" or .key_type == "publishable")
  | .opaque_key // .api_key // empty' 2>/dev/null | head -1) || ANON_KEY=""

SERVICE_KEY=$(echo "$PROJECT_BODY" | jq -r '
  (.data.api_keys // .api_keys // [])[]
  | select(.name == "service_role" or .key_type == "secret")
  | .opaque_key // .api_key // empty' 2>/dev/null | head -1) || SERVICE_KEY=""

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Complete! New RDS + Project Ready${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Environment${NC}"
echo -e "    Type:           $ENV"
echo -e "    Dry-Run:        $DRY_RUN"
echo ""
echo -e "  ${CYAN}Aurora Cluster${NC}"
echo -e "    Cluster ID:     $CLUSTER_ID"
echo -e "    Writer:         $CLUSTER_ENDPOINT"
echo -e "    Reader:         $READER_ENDPOINT"
echo -e "    Engine:         aurora-postgresql $ENGINE_VERSION (IO/Optimized)"
echo -e "    Capacity:       ${MIN_ACU}-${MAX_ACU} ACU (Serverless v2)"
echo -e "    Readers:        $READER_COUNT"
echo -e "    Cluster PG:     $CLUSTER_PG"
echo -e "    DB PG:          $DB_PG"
echo -e "    Security Group: $WORKER_RDS_SG"
echo -e "    Secret:         $SECRET_NAME"
echo ""
echo -e "  ${CYAN}Project${NC}"
echo -e "    Ref:            $PROJECT_REF"
echo -e "    Status:         $PROJECT_STATUS"
echo -e "    API Endpoint:   https://${PROJECT_REF}.${BASE_DOMAIN}"
[ -n "${ANON_KEY:-}" ]    && echo -e "    Anon Key:       $ANON_KEY"
[ -n "${SERVICE_KEY:-}" ] && echo -e "    Service Key:    $SERVICE_KEY"
echo ""
