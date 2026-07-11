#!/usr/bin/env bash
# Wraps a command with infra/.env sourced into its environment.
# Strips CRLF from infra/.env first (Windows checkouts).
# Used by `make dev-backend` so the api connects with the right credentials.

set -euo pipefail

if [ ! -f infra/.env ]; then
  echo "infra/.env not found. Run: cp infra/.env.example infra/.env and edit." >&2
  exit 1
fi

# Self-normalize CRLF so bash can source it.
if grep -q $'\r' infra/.env 2>/dev/null; then
  echo "Stripping CRLF from infra/.env (Windows checkout detected)..." >&2
  tr -d '\r' < infra/.env > infra/.env.tmp && mv infra/.env.tmp infra/.env
fi

cd "$(dirname "$0")/../.."

# Export every var defined in infra/.env, then exec the requested command.
set -a
# shellcheck disable=SC1091
. ./infra/.env
set +a

exec "$@"