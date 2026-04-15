#!/usr/bin/env bash
#
# Supabase-on-AWS Test Runner
#
# Auto-detects all configuration from CloudFormation outputs and config.json.
# No manual editing required.
#
# Prerequisites:
#   pip install -r requirements.txt
#   AWS CLI configured with access to the deployed stack
#
# Usage:
#   cd tests
#   ./RUN_TESTS.sh              # Run studio tests (default, recommended for deployment verification)
#   ./RUN_TESTS.sh studio       # Same as above
#   ./RUN_TESTS.sh auth         # Auth (GoTrue) tests (13 tests)
#   ./RUN_TESTS.sh schema       # Schema cache bug repro (7 tests, needs PROJECT_REF)
#   ./RUN_TESTS.sh all          # Run all test suites
#
# Environment variable overrides (all optional, auto-detected if not set):
#   REGION                      AWS region (from config.json)
#   STACK_NAME                  CloudFormation stack name (default: SupabaseStack)
#   STUDIO_ALB                  Studio ALB hostname (from CloudFormation)
#   SUPABASE_DOMAIN             Base domain (from config.json)
#   PROJECT_REF                 Existing project ref (skip creation)
#   KEEP_PROJECT                Set to 1 to keep project after tests
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_JSON="$PROJECT_ROOT/config.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[CONFIG]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}     $*"; }
fail() { echo -e "${RED}[FAIL]${NC}   $*"; exit 1; }

# ============================================
# Auto-detect configuration
# ============================================

command -v jq  >/dev/null 2>&1 || fail "jq not found (brew install jq)"
command -v aws >/dev/null 2>&1 || fail "aws CLI not found"

# Read from config.json
if [ ! -f "$CONFIG_JSON" ]; then
  fail "config.json not found at $CONFIG_JSON"
fi

REGION="${REGION:-$(jq -r '.project.region' "$CONFIG_JSON")}"
STACK_NAME="${STACK_NAME:-SupabaseStack}"

export SUPABASE_DOMAIN="${SUPABASE_DOMAIN:-$(jq -r '.domain.baseDomain' "$CONFIG_JSON")}"

# Auto-detect ALB hostnames from CloudFormation outputs
if [ -z "${STUDIO_ALB:-}" ] || [ -z "${ALB_DOMAIN:-}" ]; then
  log "Fetching ALB hostnames from CloudFormation stack: $STACK_NAME ..."
  CFN_OUTPUTS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query 'Stacks[0].Outputs' \
    --output json 2>/dev/null) || fail "Cannot read CloudFormation stack $STACK_NAME. Check AWS credentials and region."

  get_output() {
    echo "$CFN_OUTPUTS" | jq -r ".[] | select(.OutputKey==\"$1\") | .OutputValue"
  }

  export STUDIO_ALB="${STUDIO_ALB:-$(get_output "StudioALBDnsName")}"
  export ALB_DOMAIN="${ALB_DOMAIN:-$(get_output "ALBDnsName")}"
fi

[ -z "$STUDIO_ALB" ]      && fail "Cannot detect STUDIO_ALB. Set it manually or check stack outputs."
[ -z "$SUPABASE_DOMAIN" ] && fail "Cannot detect SUPABASE_DOMAIN. Check config.json domain.baseDomain."

# Auto-detect Admin API Key from Secrets Manager (for current tests)
if [ -z "${ADMIN_API_KEY:-}" ]; then
  ADMIN_API_KEY=$(aws secretsmanager get-secret-value \
    --secret-id "supabase/admin-api-key" \
    --region "$REGION" \
    --query 'SecretString' \
    --output text 2>/dev/null) || true
fi
export ADMIN_API_KEY="${ADMIN_API_KEY:-}"

# Pass through optional overrides
export PROJECT_REF="${PROJECT_REF:-}"
export KEEP_PROJECT="${KEEP_PROJECT:-}"
export SUPABASE_URL="${SUPABASE_URL:-}"
export SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"
export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

# Print detected config
echo ""
echo "=========================================="
echo " Test Configuration (auto-detected)"
echo "=========================================="
ok "Region:          $REGION"
ok "Stack:           $STACK_NAME"
ok "Studio ALB:      $STUDIO_ALB"
ok "Domain:          $SUPABASE_DOMAIN"
[ -n "$ALB_DOMAIN" ]    && ok "Kong ALB:        $ALB_DOMAIN"
[ -n "$PROJECT_REF" ]   && ok "Project Ref:     $PROJECT_REF (skip creation)"
[ -n "$KEEP_PROJECT" ]  && ok "Keep Project:    yes"
echo "=========================================="
echo ""

# ============================================
# Test Suites
# ============================================

run_studio_api() {
    echo "=========================================="
    echo " Running test_studio_api.py (30 tests)"
    echo "=========================================="
    echo " A: Project creation (2)   D: Metadata (2)"
    echo " B: API keys (2)           E: Secrets (3, skipped)"
    echo " C: SQL CRUD (8)           F: Table CRUD (8)"
    echo "                           G: SDK CRUD + RLS (8)"
    echo "=========================================="
    echo ""
    cd "$SCRIPT_DIR"
    python3 -m pytest test_studio_api.py -v -s "$@"
}

run_auth() {
    echo "=========================================="
    echo " Running test_auth.py (14 tests)"
    echo "=========================================="
    echo " A: Setup (1)              D: Login / Token (3)"
    echo " B: Health & Settings (2)  E: User Management (3)"
    echo " C: Signup (2)             F: Logout (3)"
    echo "=========================================="
    echo ""
    cd "$SCRIPT_DIR"
    python3 -m pytest test_auth.py -v -s "$@"
}

run_schema_cache() {
    echo "=========================================="
    echo " Running test_schema_cache.py (7 tests)"
    echo "=========================================="
    echo " P1: New schema exposure (3)  - BUG: requires cold start"
    echo " P2: NOTIFY reliability (4)   - BUG: LISTEN may drop"
    echo "=========================================="
    echo ""
    if [ -z "${PROJECT_REF:-}" ]; then
      fail "PROJECT_REF is required for schema cache tests"
    fi
    cd "$SCRIPT_DIR"
    python3 -m pytest test_schema_cache.py -v -s "$@"
}

run_auth_rls() {
    echo "=========================================="
    echo " Running test_authenticated_rls.py (13 tests)"
    echo "=========================================="
    echo " A: Setup (2)                D: Security (4)"
    echo " B: Signup & Login (2)       E: Cleanup (1)"
    echo " C: Authenticated CRUD (4)"
    echo "=========================================="
    echo ""
    cd "$SCRIPT_DIR"
    python3 -m pytest test_authenticated_rls.py -v -s "$@"
}

run_realtime() {
    echo "=========================================="
    echo " Running test_realtime.py (4 tests)"
    echo "=========================================="
    echo " A: Setup (1)              C: Presence (1)"
    echo " B: Broadcast (1)          D: CDC (1)"
    echo "=========================================="
    echo ""
    cd "$SCRIPT_DIR"
    python3 -m pytest test_realtime.py -v -s "$@"
}

run_functions() {
    echo "=========================================="
    echo " Running test_complete_function.py (16 tests)"
    echo "=========================================="
    echo " A: Setup (2)              D: Invoke (1)"
    echo " B: Secrets (2)            E: Update + invoke (2)"
    echo " C: Deploy (5)             F: Delete (2)"
    echo "                           G: Cleanup (2)"
    echo "=========================================="
    echo ""
    cd "$SCRIPT_DIR"
    python3 -m pytest test_complete_function.py -v -s "$@"
}

run_isolation() {
    echo "=========================================="
    echo " Running test_tenant_isolation.py (11 tests)"
    echo "=========================================="
    echo " Setup: Create 2 projects + table (3)"
    echo " Self-access: B reads own data (2)"
    echo " Cross-project: read/write/delete blocked (5)"
    echo " Cleanup: Drop table (1)"
    echo "=========================================="
    echo ""
    cd "$SCRIPT_DIR"
    python3 -m pytest test_tenant_isolation.py -v -s "$@"
}

run_all() {
    echo "=========================================="
    echo " Running ALL test suites"
    echo "=========================================="
    echo ""

    run_studio_api
    echo ""

    run_auth
    echo ""

    run_auth_rls
    echo ""

    run_realtime
    echo ""

    run_isolation
    echo ""

    run_functions
    echo ""

    echo "=========================================="
    echo " All test suites completed"
    echo "=========================================="
}

# ============================================
# Main
# ============================================

usage() {
    echo "Usage: $0 [suite] [pytest-args...]"
    echo ""
    echo "Suites:"
    echo "  studio (default)   test_studio_api.py  - Studio Management API (30 tests)"
    echo "  auth               test_auth.py        - Auth / GoTrue (14 tests)"
    echo "  auth-rls           test_authenticated_rls.py - Authenticated user RLS (13 tests)"
    echo "  schema             test_schema_cache.py - Schema cache bug repro (7 tests, needs PROJECT_REF)"
    echo "  realtime           test_realtime.py    - Realtime: Broadcast, Presence, CDC (4 tests)"
    echo "  isolation          test_tenant_isolation.py - Cross-tenant isolation (8 tests)"
    echo "  functions          test_complete_function.py - Edge Functions lifecycle (16 tests)"
    echo "  all                Run all test suites"
    echo ""
    echo "All configuration is auto-detected from CloudFormation + config.json."
    echo ""
    echo "Optional overrides:"
    echo "  REGION             AWS region"
    echo "  STACK_NAME         CloudFormation stack name"
    echo "  PROJECT_REF        Existing project ref (skip creation)"
    echo "  KEEP_PROJECT=1     Keep project after tests"
    echo ""
    echo "Examples:"
    echo "  ./RUN_TESTS.sh                          # Run studio tests (auto-detect everything)"
    echo "  ./RUN_TESTS.sh studio -k TestG          # Run only SDK CRUD tests"
    echo "  PROJECT_REF=abc123 ./RUN_TESTS.sh       # Use existing project"
    echo "  KEEP_PROJECT=1 ./RUN_TESTS.sh           # Keep project after tests"
}

SUITE="${1:-studio}"

# Shift suite arg so remaining args pass to pytest
if [[ "$SUITE" =~ ^(all|studio|auth|auth-rls|schema|realtime|isolation|functions)$ ]]; then
  shift 2>/dev/null || true
fi

case "$SUITE" in
    studio)    run_studio_api "$@" ;;
    auth)      run_auth "$@" ;;
    auth-rls)  run_auth_rls "$@" ;;
    schema)    run_schema_cache "$@" ;;
    realtime)  run_realtime "$@" ;;
    isolation) run_isolation "$@" ;;
    functions) run_functions "$@" ;;
    all)       run_all ;;
    -h|--help) usage ;;
    *)
        echo "Unknown suite: $SUITE"
        usage
        exit 1
        ;;
esac
