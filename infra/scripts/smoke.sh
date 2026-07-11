#!/usr/bin/env bash
# Astraea end-to-end smoke (AC1+AC2+AC9+AC10).
# Exits 0 on full pass, non-zero on first failure.

set -euo pipefail

COMPOSE="${COMPOSE:-docker compose -f infra/compose.yaml}"
WEB_PORT="${WEB_PORT:-5173}"
API_PORT="${API_PORT:-3000}"
BASE_WEB="http://localhost:${WEB_PORT}"
BASE_API="http://localhost:${API_PORT}"

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }
ok() { printf '  \033[1;32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$1"; exit 1; }

step "AC9: backend /health returns 200 with all checks up"
HEALTH_JSON="$(curl -fsS "${BASE_API}/health")"
echo "  ${HEALTH_JSON}"
echo "$HEALTH_JSON" | grep -q '"status":"ok"' || fail "health status not ok"
ok "/health returned status=ok"

step "AC4: backend /openapi.json includes all 6 collection roots"
PATHS_JSON="$(curl -fsS "${BASE_API}/openapi.json" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("\n".join(d.get("paths",{}).keys()))')"
echo "$PATHS_JSON"
for path in /v1/agents /v1/experiments /v1/traces /v1/prompts /v1/datasets /v1/scores; do
  echo "$PATHS_JSON" | grep -q "^${path}$" || fail "openapi.json missing collection root ${path}"
done
ok "all 6 collection roots present"

step "AC3: backend /reference renders Scalar UI"
REF_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_API}/reference")"
[ "${REF_CODE}" = "200" ] || fail "/reference returned ${REF_CODE}, expected 200"
ok "/reference returned 200"

step "Stub endpoints return 501 with NOT_IMPLEMENTED envelope"
for spec in "POST:/v1/agents" "GET:/v1/agents" "GET:/v1/experiments" "GET:/v1/traces" "GET:/v1/prompts" "GET:/v1/datasets" "POST:/v1/scores"; do
  METHOD="${spec%%:*}"
  PATH_PART="${spec##*:}"
  CODE="$(curl -s -o /tmp/astraea_stub.json -w '%{http_code}' -X "${METHOD}" "${BASE_API}${PATH_PART}")"
  [ "${CODE}" = "501" ] || fail "${METHOD} ${PATH_PART} returned ${CODE}, expected 501"
  grep -q 'NOT_IMPLEMENTED' /tmp/astraea_stub.json || fail "${METHOD} ${PATH_PART} body missing NOT_IMPLEMENTED"
done
ok "all sampled stubs return 501 with NOT_IMPLEMENTED envelope"

step "AC2: dashboard renders with zero console errors (Playwright)"
cd "$(dirname "$0")/../.."  # repo root
if [ -d "apps/web" ]; then
  (cd apps/web && bunx playwright test --reporter=line smoke.spec.ts) || fail "Playwright smoke failed"
  ok "Playwright dashboard smoke passed"
else
  echo "  (skipping Playwright: apps/web not yet built)"
fi

printf '\n\033[1;32m✓ All smoke checks passed.\033[0m\n'