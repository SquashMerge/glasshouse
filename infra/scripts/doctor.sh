#!/usr/bin/env bash
# Astraea dev-env doctor. Asserts:
#   - infra/.env exists (not .env.example)
#   - .env does NOT contain any CHANGE_ME placeholders
#   - Required tools are installed at minimum versions
# Exits 0 on ready, non-zero on first failure.

# CRLF guard: re-exec through a normalized copy if checked out with \r.
if grep -q $'\r' "$0" 2>/dev/null; then
  TMP="$(mktemp)"
  tr -d '\r' < "$0" > "$TMP"
  chmod +x "$TMP"
  exec bash "$TMP" "$@"
fi

set -euo pipefail

step() { printf '\033[1;34m▶ %s\033[0m\n' "$1"; }
ok() { printf '  \033[1;32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$1"; exit 1; }
version_at_least() {
  local actual="$1" required="$2" actual_part required_part i
  [[ "$actual" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$required" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  local IFS=.
  local -a actual_parts required_parts
  read -r -a actual_parts <<< "$actual"
  read -r -a required_parts <<< "$required"
  for i in 0 1 2; do
    actual_part="${actual_parts[i]:-0}"
    required_part="${required_parts[i]:-0}"
    actual_part="${actual_part%%[^0-9]*}"
    required_part="${required_part%%[^0-9]*}"
    [[ "$actual_part" =~ ^[0-9]+$ && "$required_part" =~ ^[0-9]+$ ]] || return 1
    if (( 10#$actual_part > 10#$required_part )); then return 0; fi
    if (( 10#$actual_part < 10#$required_part )); then return 1; fi
  done
  return 0
}
effective_env_value() {
  bash -c 'set -a -u; source "$1"; printf %s "${!2}"' bash infra/.env "$1"
}

cd "$(dirname "$0")/../.."

step "infra/.env must exist"
[ -f infra/.env ] || fail "infra/.env not found. Run: cp infra/.env.example infra/.env"
ok "infra/.env exists"

# Self-normalize CRLF (Windows checkouts) so subsequent steps can source it.
if grep -q $'\r' infra/.env; then
  step "Stripping CRLF from infra/.env (Windows checkout detected)"
  tr -d '\r' < infra/.env > infra/.env.tmp && mv infra/.env.tmp infra/.env
  ok "infra/.env normalized to LF"
fi

step ".env must not contain CHANGE_ME placeholders"
if grep -q '^[^#]*CHANGE_ME' infra/.env; then
  fail "infra/.env still contains CHANGE_ME placeholders. Edit secrets before starting."
fi
ok "no CHANGE_ME placeholders"

step "Required env vars present and non-empty in infra/.env"
REQUIRED_VARS=(POSTGRES_USER POSTGRES_PASSWORD CLICKHOUSE_USER CLICKHOUSE_PASSWORD VALKEY_PASSWORD UI_USERNAME UI_PASSWORD ASTRAEA_BOOTSTRAP_OWNER_USERNAME GEPA_ALLOWED_MODELS)
MISSING=0
for v in "${REQUIRED_VARS[@]}"; do
  line=$(grep "^${v}=" infra/.env || true)
  if [ -z "$line" ]; then
    echo "  ! ${v} missing from infra/.env"
    MISSING=1
  else
    if ! effective_value=$(effective_env_value "$v"); then
      fail "unable to source infra/.env while validating ${v}"
    fi
    if [[ "$effective_value" =~ ^[[:space:]]*$ ]]; then
      echo "  ! ${v} is empty in infra/.env"
      MISSING=1
    fi
  fi
done
[ "$MISSING" = "0" ] || fail "missing required vars; edit infra/.env"

step "Optional redaction env vars are well-formed (if set)"
for v in ASTRAEA_REDACT_INPUT ASTRAEA_REDACT_KEYS API_MAX_BODY_BYTES; do
  line=$(grep "^${v}=" infra/.env || true)
  [ -z "$line" ] && continue
  if ! val=$(effective_env_value "$v"); then
    fail "unable to source infra/.env while validating ${v}"
  fi
  case "$v" in
    ASTRAEA_REDACT_INPUT)
      case "$val" in
        true|false) ;;
        *) echo "  ! ${v} must be 'true' or 'false' (got: $val)"; MISSING=1 ;;
      esac
      ;;
    API_MAX_BODY_BYTES)
      if ! node -e 'const value = Number(process.argv[1]); process.exit(Number.isSafeInteger(value) && value > 0 ? 0 : 1)' "$val"; then
        echo "  ! ${v} must be a positive safe integer (got: $val)"; MISSING=1
      fi
      ;;
  esac
done

step "Auth vars UI_USERNAME and UI_PASSWORD must not be empty"
for v in UI_USERNAME UI_PASSWORD; do
  val=$(grep "^${v}=" infra/.env | cut -d= -f2-)
  if [ -z "$val" ]; then
    echo "  ! ${v} is empty in infra/.env"
    MISSING=1
  fi
done
[ "$MISSING" = "0" ] || fail "auth vars empty; edit infra/.env"
ok "all required vars present"

step "Docker"
docker --version >/dev/null || fail "docker not installed"
ok "docker installed"

step "Docker Compose v2.13+ (required for depends_on condition: service_healthy)"
COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || echo 0)"
COMPOSE_MAJOR_MINOR="${COMPOSE_VERSION%%.*}"
COMPOSE_MINOR="${COMPOSE_VERSION#*.}"
COMPOSE_MINOR="${COMPOSE_MINOR%%.*}"
if [ "${COMPOSE_MAJOR_MINOR}" -lt 2 ] 2>/dev/null || { [ "${COMPOSE_MAJOR_MINOR}" = "2" ] && [ "${COMPOSE_MINOR}" -lt 13 ]; } 2>/dev/null; then
  fail "docker compose ${COMPOSE_VERSION} found; v2.13+ required"
fi
ok "docker compose ${COMPOSE_VERSION}"

step "Bun 1.3.14+"
bun --version >/dev/null || fail "bun not installed (https://bun.sh)"
BUN_VERSION="$(bun --version)"
version_at_least "$BUN_VERSION" "1.3.14" || fail "bun ${BUN_VERSION} found; 1.3.14+ required"
ok "bun ${BUN_VERSION}"

step "Node.js 22.12.0+"
node --version >/dev/null || fail "node not installed (https://nodejs.org)"
NODE_VERSION="$(node --version)"
NODE_VERSION="${NODE_VERSION#v}"
version_at_least "$NODE_VERSION" "22.12.0" || fail "node ${NODE_VERSION} found; 22.12.0+ required"
ok "node ${NODE_VERSION}"

step "uv (for openapi-python-client)"
uv --version >/dev/null || fail "uv not installed (https://docs.astral.sh/uv/)"
ok "uv $(uv --version)"

printf '\n\033[1;32m✓ Environment ready.\033[0m Run \`make install\` then \`make dev\` to boot the stack.\n'