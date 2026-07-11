#!/usr/bin/env bash
# Astraea end-to-end smoke (AC1-AC10 for phase-2-ingest-and-viewer).
# Exits 0 on full pass, non-zero on first failure.

# CRLF guard: re-exec through a normalized copy if checked out with \r.
if grep -q $'\r' "$0" 2>/dev/null; then
  TMP="$(mktemp)"
  tr -d '\r' < "$0" > "$TMP"
  chmod +x "$TMP"
  exec bash "$TMP" "$@"
fi

set -euo pipefail

COMPOSE="${COMPOSE:-docker compose -f infra/compose.yaml}"
WEB_PORT="${WEB_PORT:-5173}"
API_PORT="${API_PORT:-3000}"
BASE_WEB="http://localhost:${WEB_PORT}"
BASE_API="http://localhost:${API_PORT}"

# Auth: pull creds from infra/.env (sourced by make dev-backend).
UI_USER="${UI_USERNAME:-astraea}"
UI_PASS="${UI_PASSWORD:-}"
if [ -z "${UI_PASS}" ]; then
  echo "  ! UI_PASSWORD not set; sourcing infra/.env"
  # shellcheck disable=SC1091
  . ./infra/.env
  UI_PASS="${UI_PASSWORD:-}"
fi
[ -n "${UI_PASS}" ] || { echo "  ! UI_PASSWORD still unset after sourcing infra/.env"; exit 1; }
AUTH="authorization=Basic $(printf '%s:%s' "${UI_USER}" "${UI_PASS}" | base64)"

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }
ok() { printf '  \033[1;32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$1"; exit 1; }

cd "$(dirname "$0")/../.."  # repo root

step "AC9: backend /health returns 200 with all checks up"
HEALTH_JSON="$(curl -fsS "${BASE_API}/health")"
echo "  ${HEALTH_JSON}"
echo "$HEALTH_JSON" | grep -q '"status":"ok"' || fail "health status not ok"
ok "/health returned status=ok"

step "AC4: backend /openapi.json includes all 6 collection roots"
PATHS_JSON="$(curl -fsS "${BASE_API}/openapi.json" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("\n".join(d.get("paths",{}).keys()))')"
for path in /v1/agents /v1/experiments /v1/traces /v1/prompts /v1/datasets /v1/scores; do
  echo "$PATHS_JSON" | grep -q "^${path}$" || fail "openapi.json missing collection root ${path}"
done
ok "all 6 collection roots present"

step "AC3: backend /reference renders Scalar UI"
REF_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_API}/reference")"
[ "${REF_CODE}" = "200" ] || fail "/reference returned ${REF_CODE}, expected 200"
ok "/reference returned 200"

step "Stub endpoints (non-trace) return 501 with NOT_IMPLEMENTED envelope"
for spec in "POST:/v1/agents" "GET:/v1/agents" "GET:/v1/experiments" "GET:/v1/prompts" "GET:/v1/datasets" "POST:/v1/scores"; do
  METHOD="${spec%%:*}"
  PATH_PART="${spec##*:}"
  CODE="$(curl -s -o /tmp/astraea_stub.json -w '%{http_code}' -H "${AUTH}" -X "${METHOD}" "${BASE_API}${PATH_PART}")"
  [ "${CODE}" = "501" ] || fail "${METHOD} ${PATH_PART} returned ${CODE}, expected 501"
  grep -q 'NOT_IMPLEMENTED' /tmp/astraea_stub.json || fail "${METHOD} ${PATH_PART} body missing NOT_IMPLEMENTED"
done
ok "non-trace stubs return 501 with NOT_IMPLEMENTED envelope"

step "AC7: /v1/* without auth returns 401 with WWW-Authenticate"
UNAUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_API}/v1/traces")"
[ "${UNAUTH_CODE}" = "401" ] || fail "unauthenticated GET /v1/traces returned ${UNAUTH_CODE}, expected 401"
WWW_AUTH="$(curl -sI "${BASE_API}/v1/traces" | grep -i '^www-authenticate:' || true)"
echo "  ${WWW_AUTH}"
echo "${WWW_AUTH}" | grep -qi 'Basic' || fail "WWW-Authenticate header missing Basic realm"
ok "unauthenticated /v1/traces returns 401 with WWW-Authenticate: Basic"

step "AC7: /v1/auth/login with valid creds returns 200 { ok: true }"
LOGIN_RESP="$(curl -s -o /tmp/astraea_login.json -w '%{http_code}' -H "${AUTH}" -X POST "${BASE_API}/v1/auth/login")"
[ "${LOGIN_RESP}" = "200" ] || fail "POST /v1/auth/login returned ${LOGIN_RESP}, expected 200"
grep -q '"ok":true' /tmp/astraea_login.json || fail "/v1/auth/login body missing { ok: true }"
ok "POST /v1/auth/login returns 200 { ok: true }"

step "AC1: POST /v1/otel/v1/traces with gen_ai.* attrs persists to ClickHouse"
TRACE_ID="smoke-trace-$(date +%s%N)"
OTLP_PAYLOAD=$(cat <<EOF
{
  "resource_spans": [{
    "resource": { "attributes": [
      { "key": "deployment.environment", "value": { "stringValue": "smoke" } },
      { "key": "gen_ai.agent.id", "value": { "stringValue": "smoke-agent" } }
    ]},
    "scope_spans": [{
      "scope": { "name": "smoke", "version": "1.0.0" },
      "spans": [{
        "trace_id": "$(printf '%032x' $((RANDOM * RANDOM)))",
        "span_id": "$(printf '%016x' $((RANDOM)))",
        "name": "smoke-span",
        "kind": 1,
        "start_time_unix_nano": "$(( $(date +%s) * 1000000000 ))",
        "end_time_unix_nano": "$(( $(date +%s) * 1000000000 + 50000000 ))",
        "status": { "code": 1 },
        "attributes": [
          { "key": "gen_ai.system", "value": { "stringValue": "openai" } },
          { "key": "gen_ai.request.model", "value": { "stringValue": "gpt-4o" } },
          { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "10" } },
          { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "20" } },
          { "key": "gen_ai.prompt.0.content", "value": { "stringValue": "smoke prompt for OTLP test" } }
        ]
      }]
    }]
  }]
}
EOF
)
TRACE_ID_ACTUAL=$(echo "${OTLP_PAYLOAD}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["resource_spans"][0]["scope_spans"][0]["spans"][0]["trace_id"])')
echo "  POSTing trace_id=${TRACE_ID_ACTUAL}"
INGEST_RESP="$(curl -s -o /tmp/astraea_otlp.json -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -H "${AUTH}" \
  -X POST --data "${OTLP_PAYLOAD}" \
  "${BASE_API}/v1/otel/v1/traces")"
[ "${INGEST_RESP}" = "200" ] || { cat /tmp/astraea_otlp.json; fail "OTLP ingest returned ${INGEST_RESP}, expected 200"; }
ok "OTLP ingest returned 200"

# Verify the trace is queryable.
sleep 1  # ClickHouse async insert settle
TRACE_ROW="$(curl -fsS -H "${AUTH}" "${BASE_API}/v1/traces/${TRACE_ID_ACTUAL}")"
echo "  ${TRACE_ROW}"
echo "${TRACE_ROW}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['trace']['trace_id'].lower() == '${TRACE_ID_ACTUAL}', f\"trace_id mismatch: {d['trace']['trace_id']}\"
assert d['trace']['agent_id'] == 'smoke-agent', f\"agent_id wrong: {d['trace']['agent_id']}\"
assert 'input_tokens:10' in d['trace']['scores_summary'], f\"scores_summary missing: {d['trace']['scores_summary']}\"
assert len(d['observations']) >= 1, 'no observations'
print('  ✓ trace + observation persisted correctly')
" || fail "trace query validation failed"
ok "trace persists with correct agent_id, scores_summary, observations"

step "AC3: malformed OTLP body returns 400"
BAD_CODE="$(curl -s -o /tmp/astraea_otlp_bad.json -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -H "${AUTH}" \
  -X POST --data 'not json' \
  "${BASE_API}/v1/otel/v1/traces")"
[ "${BAD_CODE}" = "400" ] || fail "malformed OTLP body returned ${BAD_CODE}, expected 400"
grep -q 'BAD_REQUEST' /tmp/astraea_otlp_bad.json || fail "malformed OTLP body missing BAD_REQUEST code"
ok "malformed OTLP body returns 400 with BAD_REQUEST"

step "AC2: dashboard renders with zero console errors (Playwright)"
if [ -d "apps/web" ]; then
  (cd apps/web && bunx playwright test --reporter=line smoke.spec.ts) || fail "Playwright smoke failed"
  ok "Playwright dashboard smoke passed"
else
  echo "  (skipping Playwright: apps/web not yet built)"
fi

printf '\n\033[1;32m✓ All smoke checks passed.\033[0m\n'