#!/usr/bin/env bash
# Run only on a disposable hosted runner with Docker and Compose installed.
set -euo pipefail
archive="${1:?image archive is required}"
bundle="${2:?deployment bundle is required}"
image="${3:?loaded image reference is required}"
[[ -f "$archive" ]] || { printf 'archive not found\n' >&2; exit 1; }
[[ -f "$bundle" ]] || { printf 'bundle not found\n' >&2; exit 1; }
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/glasshouse-release.XXXXXXXX")"
project="release-ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$RANDOM"
tar -xzf "$bundle" -C "$work"
cat > "$work/test.env" <<EOF
GLASSHOUSE_IMAGE=$image
POSTGRES_USER=glasshouse_ci
POSTGRES_PASSWORD=synthetic-postgres-pass
POSTGRES_DB=glasshouse_ci
CLICKHOUSE_USER=glasshouse_ci
CLICKHOUSE_PASSWORD=synthetic-clickhouse-pass
CLICKHOUSE_DB=glasshouse_ci
VALKEY_PASSWORD=synthetic-valkey-pass
UI_USERNAME=synthetic-owner
UI_PASSWORD=synthetic-owner-pass
GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME=synthetic-owner
GLASSHOUSE_PUBLIC_ORIGIN=https://glasshouse.example.invalid
GLASSHOUSE_AUTH_BOOTSTRAP_MODE=basic
GEPA_ALLOWED_MODELS=openai/gpt-4o-mini
GEPA_WORKER_MODE=gepa
API_PORT=34762
EOF
set -a
# shellcheck disable=SC1091
source "$work/test.env"
set +a
compose=(docker compose --project-directory "$work" --env-file "$work/test.env" --project-name "$project" -f "$work/compose.yaml")
finish() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    "${compose[@]}" ps --all || true
    "${compose[@]}" logs --no-color --tail=100 || true
  fi
  "${compose[@]}" down --remove-orphans || true
  rm -rf -- "$work"
  exit "$status"
}
trap finish EXIT

archive_hash="$(sha256sum "$archive")"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
"${compose[@]}" pull postgres clickhouse valkey
"${compose[@]}" up --detach --no-build --pull never --wait --wait-timeout 240
test "$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q app)")" = "$image_id"
check_migrations() {
  pg="$("${compose[@]}" exec -T postgres psql -U glasshouse_ci -d glasshouse_ci -Atqc 'SELECT count(*) FROM pgmigrations')"
  ch="$("${compose[@]}" exec -T clickhouse clickhouse-client --user glasshouse_ci --password synthetic-clickhouse-pass --database glasshouse_ci --query 'SELECT count() FROM glasshouse_schema_migrations')"
  test "$pg" = "$(find "$root/infra/db/migrations" -maxdepth 1 -name '*.sql' -type f | wc -l | tr -d ' ')"
  test "$ch" = "$(find "$root/infra/db/clickhouse" -maxdepth 1 -name '*.sql' -type f | wc -l | tr -d ' ')"
  printf '%s %s\n' "$pg" "$ch"
}
check_migrations > "$work/first"
"${compose[@]}" restart app
"${compose[@]}" up --detach --no-deps --no-build --pull never --wait --wait-timeout 240 app
check_migrations > "$work/second"
cmp "$work/first" "$work/second"
base=http://127.0.0.1:34762
curl --fail --silent --show-error "$base/" > "$work/index.html"
asset="$(python3 - "$work/index.html" <<'PY'
import re,sys
html=open(sys.argv[1]).read()
assert '<div id="root"></div>' in html
matches=re.findall(r'<script[^>]+src="(/assets/[^\"]+\.js)"', html)
assert len(matches)==1
print(matches[0])
PY
)"
curl --fail --silent --show-error "$base$asset" > "$work/asset.js"
test -s "$work/asset.js"
curl --fail --silent --show-error "$base/v1/health" >/dev/null
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "$base/v1/projects")" = 401
curl --fail --silent --show-error --user synthetic-owner:synthetic-owner-pass "$base/v1/projects" > "$work/projects.json"
project_id="$(python3 - "$work/projects.json" <<'PY'
import json,sys
ids=[item['id'] for item in json.load(open(sys.argv[1]))['items'] if item['slug']=='default']
assert len(ids)==1
print(ids[0])
PY
)"
set +e
curl --silent --show-error --fail --no-buffer --max-time 8 --user synthetic-owner:synthetic-owner-pass "$base/v1/traces/events?project_id=$project_id" > "$work/stream"
status=$?
set -e
test "$status" = 28
python3 - "$work/stream" <<'PY'
import sys
assert ':ok' in open(sys.argv[1]).read()
PY
test "$archive_hash" = "$(sha256sum "$archive")"
printf 'Exported image passed release-bundle integration.\n'
