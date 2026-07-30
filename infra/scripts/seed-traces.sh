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
#   --dry-run         build payloads without POSTing
#   --seed N          rng seed for reproducibility
#
# Prereqs: api running (`make dev-backend` or `make dev`) and infra/.env with
# UI_USERNAME + UI_PASSWORD set.

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