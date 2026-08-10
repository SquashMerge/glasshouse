#!/usr/bin/env bash
# Astraea trace seeder. Posts OTLP traces to the local api to bulk-load
# traces + observations for query-perf testing or UI demos.
#
# Usage:
#   infra/scripts/seed-traces.sh                            # 100k traces, mixed convention
#   infra/scripts/seed-traces.sh --count 1000 --convention genai
#   SEED_COUNT=50000 SEED_CONVENTION=openinference infra/scripts/seed-traces.sh
#
# Options (CLI flags or SEED_* env vars):
#   --count N         number of traces       (default 100000)
#   --convention C    genai|openinference|mixed (default mixed)
#   --batch-size N    traces per OTLP POST   (default 50)
#   --days N          spread across last N days (default 30)
#   --min-spans N     min spans per trace    (default 2)
#   --max-spans N     max spans per trace    (default 5)
#   --concurrency N   parallel POST workers  (default 8)
#   --url URL         api base url           (default http://localhost:3000)
#   --project-id ID   target project UUID (default: authenticated org's default project)
#   --username NAME   Basic auth username (default: UI_USERNAME or astraea)
#   --password VALUE  Basic auth password (default: UI_PASSWORD)
#   --dry-run         build payloads without POSTing
#   --seed N          rng seed for reproducibility
#
# Prereqs: API running (`make dev-backend` or `make dev`) and a configured Basic
# credential. Use UI_USERNAME + UI_PASSWORD from infra/.env, or pass --username
# and --password for one entry in ASTRAEA_BASIC_AUTH_CREDENTIALS.

if grep -q $'\r' "$0" 2>/dev/null; then
  TMP="$(mktemp)"
  tr -d '\r' < "$0" > "$TMP"
  chmod +x "$TMP"
  exec bash "$TMP" "$@"
fi

set -euo pipefail

cd "$(dirname "$0")/../.."  # repo root

if [ -f infra/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./infra/.env
  set +a
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required (install via brew / apt / system Python)" >&2
  exit 1
fi

exec python3 infra/scripts/seed_traces.py "$@"