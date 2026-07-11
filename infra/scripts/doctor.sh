#!/usr/bin/env bash
# Astraea dev-env doctor. Asserts:
#   - infra/.env exists (not .env.example)
#   - .env does NOT contain any CHANGE_ME placeholders
#   - Required tools are installed at minimum versions
# Exits 0 on ready, non-zero on first failure.

set -euo pipefail

step() { printf '\033[1;34m▶ %s\033[0m\n' "$1"; }
ok() { printf '  \033[1;32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$1"; exit 1; }

cd "$(dirname "$0")/../.."

step "infra/.env must exist"
[ -f infra/.env ] || fail "infra/.env not found. Run: cp infra/.env.example infra/.env"
ok "infra/.env exists"

step ".env must not contain CHANGE_ME placeholders"
if grep -q '^[^#]*CHANGE_ME' infra/.env; then
  fail "infra/.env still contains CHANGE_ME placeholders. Edit secrets before starting."
fi
ok "no CHANGE_ME placeholders"

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

step "Bun 1.1.0+"
bun --version >/dev/null || fail "bun not installed (https://bun.sh)"
BUN_VERSION="$(bun --version)"
BUN_MAJOR="${BUN_VERSION%%.*}"
BUN_MINOR="${BUN_VERSION#*.}"
BUN_MINOR="${BUN_MINOR%%.*}"
if [ "${BUN_MAJOR}" -lt 1 ] 2>/dev/null || { [ "${BUN_MAJOR}" = "1" ] && [ "${BUN_MINOR}" -lt 1 ]; } 2>/dev/null; then
  fail "bun ${BUN_VERSION} found; 1.1.0+ required"
fi
ok "bun ${BUN_VERSION}"

step "uv (for openapi-python-client)"
uv --version >/dev/null || fail "uv not installed (https://docs.astral.sh/uv/)"
ok "uv $(uv --version)"

printf '\n\033[1;32m✓ Environment ready.\033[0m Run \`make install\` then \`make dev\` to boot the stack.\n'