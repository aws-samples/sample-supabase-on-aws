#!/bin/bash
# CORS Preflight (OPTIONS) test script
# Tests whether Kong correctly handles browser CORS preflight requests
#
# Usage:
#   ./test_cors_preflight.sh <project_ref>
#   PROJECT_REF=xxx ./test_cors_preflight.sh
#
# Example:
#   ./test_cors_preflight.sh b6nuzri3h39zxddtd2uu

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/../config.json"
if [ -f "$CONFIG_FILE" ]; then
  DOMAIN="${DOMAIN:-$(jq -r '.domain.baseDomain' "$CONFIG_FILE")}"
else
  DOMAIN="${DOMAIN:-example.com}"
fi
PROJECT_REF="${1:-${PROJECT_REF:-}}"

if [ -z "$PROJECT_REF" ]; then
  echo "Usage: $0 <project_ref>"
  echo "  or:  PROJECT_REF=xxx $0"
  exit 1
fi

BASE_URL="https://${PROJECT_REF}.${DOMAIN}"
ORIGIN="http://localhost:3000"
PASS=0
FAIL=0

test_cors() {
  local name="$1"
  local path="$2"
  local method="${3:-POST}"
  local headers="${4:-apikey,authorization,content-type,x-client-info,x-supabase-api-version}"

  echo ""
  echo "=== Test: ${name} ==="
  echo "  URL: ${BASE_URL}${path}"
  echo "  Origin: ${ORIGIN}"
  echo "  Request-Method: ${method}"
  echo "  Request-Headers: ${headers}"
  echo ""

  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "${BASE_URL}${path}" \
    -H "Accept: */*" \
    -H "Origin: ${ORIGIN}" \
    -H "Access-Control-Request-Method: ${method}" \
    -H "Access-Control-Request-Headers: ${headers}" \
    -H "Sec-Fetch-Dest: empty" \
    -H "Sec-Fetch-Mode: cors" \
    -H "Sec-Fetch-Site: cross-site" \
    --insecure 2>/dev/null)

  echo "  HTTP Status: ${RESP}"

  # Get full headers
  HEADERS=$(curl -s -D - -o /dev/null -X OPTIONS "${BASE_URL}${path}" \
    -H "Accept: */*" \
    -H "Origin: ${ORIGIN}" \
    -H "Access-Control-Request-Method: ${method}" \
    -H "Access-Control-Request-Headers: ${headers}" \
    -H "Sec-Fetch-Dest: empty" \
    -H "Sec-Fetch-Mode: cors" \
    -H "Sec-Fetch-Site: cross-site" \
    --insecure 2>/dev/null)

  echo "  Response Headers:"
  echo "${HEADERS}" | grep -i "access-control" | sed 's/^/    /' || echo "    (none)"

  ACAO=$(echo "${HEADERS}" | grep -i "access-control-allow-origin" | tr -d '\r' || true)

  if [[ "${RESP}" == "200" || "${RESP}" == "204" ]] && [[ -n "${ACAO}" ]]; then
    echo "  Result: PASS"
    PASS=$((PASS + 1))
  else
    echo "  Result: FAIL"
    FAIL=$((FAIL + 1))
  fi
}

echo "==========================================="
echo "CORS Preflight Test"
echo "==========================================="
echo "Domain: ${DOMAIN}"
echo "Project: ${PROJECT_REF}"
echo "Base URL: ${BASE_URL}"
echo "==========================================="

# Test 1: PostgREST route
test_cors "POST /rest/v1/" "/rest/v1/" "POST"

# Test 2: GET /rest/v1/
test_cors "GET /rest/v1/" "/rest/v1/" "GET"

# Test 3: Functions route
test_cors "POST /functions/v1/test" "/functions/v1/test" "POST"

# Test 4: Function-deploy route
test_cors "POST /api/v1/projects" "/api/v1/projects" "POST"

# Test 5: Auth route (like the user's original curl)
test_cors "POST /auth/v1/signup" "/auth/v1/signup" "POST"

# Test 6: Different origin
echo ""
echo "=== Test: Different Origin ==="
ORIGIN_ALT="https://my-app.vercel.app"
RESP=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "${BASE_URL}/rest/v1/" \
  -H "Accept: */*" \
  -H "Origin: ${ORIGIN_ALT}" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: apikey,authorization,content-type" \
  -H "Sec-Fetch-Dest: empty" \
  -H "Sec-Fetch-Mode: cors" \
  -H "Sec-Fetch-Site: cross-site" \
  --insecure 2>/dev/null)

HEADERS=$(curl -s -D - -o /dev/null -X OPTIONS "${BASE_URL}/rest/v1/" \
  -H "Accept: */*" \
  -H "Origin: ${ORIGIN_ALT}" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: apikey,authorization,content-type" \
  -H "Sec-Fetch-Dest: empty" \
  -H "Sec-Fetch-Mode: cors" \
  -H "Sec-Fetch-Site: cross-site" \
  --insecure 2>/dev/null)

echo "  URL: ${BASE_URL}/rest/v1/"
echo "  Origin: ${ORIGIN_ALT}"
echo "  HTTP Status: ${RESP}"
echo "  Response Headers:"
echo "${HEADERS}" | grep -i "access-control" | sed 's/^/    /' || echo "    (none)"

ACAO=$(echo "${HEADERS}" | grep -i "access-control-allow-origin" | tr -d '\r' || true)
if [[ "${RESP}" == "200" || "${RESP}" == "204" ]] && [[ -n "${ACAO}" ]]; then
  echo "  Result: PASS"
  PASS=$((PASS + 1))
else
  echo "  Result: FAIL"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "==========================================="
echo "Summary: ${PASS} passed, ${FAIL} failed (total $((PASS + FAIL)))"
echo "==========================================="

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
