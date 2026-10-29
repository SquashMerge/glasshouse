#!/usr/bin/env bash
# Wraps a command with infra/.env sourced into its environment.
# Strips CRLF from infra/.env first (Windows checkouts).
# Used by `make dev-backend` so the api connects with the right credentials.

set -euo pipefail

cd "$(dirname "$0")/../.."
# shellcheck source=infra/scripts/normalize-env.sh
. ./infra/scripts/normalize-env.sh

if [ ! -f infra/.env ]; then
  echo "infra/.env not found. Run: cp infra/.env.example infra/.env and edit." >&2
  exit 1
fi

normalize_env_file infra/.env

# Export every var defined in infra/.env, then exec the requested command.
set -a
# shellcheck disable=SC1091
. ./infra/.env
set +a

# A devcontainer runs the API and its data services on a private Compose
# network. Local `infra/.env` overrides describe host-published ports, so they
# must not cross that boundary when the devcontainer opts in.
if [ "${GLASSHOUSE_CONTAINER_NETWORK:-}" = "1" ]; then
  export POSTGRES_HOST=postgres
  export POSTGRES_PORT=5432
  export CLICKHOUSE_HOST=clickhouse
  export CLICKHOUSE_HTTP_PORT=8123
  export VALKEY_HOST=valkey
  export VALKEY_PORT=6379
  unset DATABASE_URL CLICKHOUSE_URL VALKEY_URL
fi

# node-pg-migrate and the bootstrap script require DATABASE_URL, while the API
# itself supports component-variable fallbacks. Derive the selected network URL
# when no explicit override is active.
if [ -z "${DATABASE_URL:-}" ]; then
  encode_uri_component() {
    printf %s "$1" | node -e 'process.stdout.write(encodeURIComponent(require("node:fs").readFileSync(0, "utf8")))'
  }
  postgres_user="$(encode_uri_component "${POSTGRES_USER:-postgres}")"
  postgres_password="$(encode_uri_component "${POSTGRES_PASSWORD:-postgres}")"
  postgres_database="$(encode_uri_component "${POSTGRES_DB:-postgres}")"
  export DATABASE_URL="postgres://${postgres_user}:${postgres_password}@${POSTGRES_HOST:-localhost}:${POSTGRES_PORT:-5432}/${postgres_database}"
fi

exec "$@"
