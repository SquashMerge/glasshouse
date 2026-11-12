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
VALKEY_PASSWORD='synthetic-valkey-#?/%@-pass'
UI_USERNAME=synthetic-owner
UI_PASSWORD=synthetic-owner-pass
GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME=synthetic-owner
GLASSHOUSE_PUBLIC_ORIGIN=https://127.0.0.1:34763
GLASSHOUSE_AUTH_BOOTSTRAP_MODE=local
GEPA_ALLOWED_MODELS=openai/gpt-4o-mini
GEPA_WORKER_MODE=gepa
API_PORT=34762
EOF
set -a
# shellcheck disable=SC1091
source "$work/test.env"
set +a
compose=(docker compose --project-directory "$work" --env-file "$work/test.env" --project-name "$project" -f "$work/compose.yaml")
proxy_pid=""
finish() {
  status=$?
  trap - EXIT
  if [[ -n "$proxy_pid" ]]; then kill "$proxy_pid" 2>/dev/null || true; wait "$proxy_pid" 2>/dev/null || true; fi
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
gzip -dc -- "$archive" | docker load
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
"${compose[@]}" pull postgres clickhouse valkey
"${compose[@]}" up --detach --no-build --pull never --wait --wait-timeout 240
test "$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q app)")" = "$image_id"
"${compose[@]}" exec -T app bun -e 'import { valkey } from "/app/apps/api/src/db/valkey.ts"; const client = valkey(); await client.connect(); if (await client.ping() !== "PONG") process.exitCode = 1; client.disconnect();'
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
base=https://127.0.0.1:34763
# Provision exactly as a fresh operator does, against the loaded release image.
python3 - "$work/setup.token" <<'PY'
import secrets, sys
from pathlib import Path
path = Path(sys.argv[1])
path.write_text(secrets.token_urlsafe(32))
path.chmod(0o600)
PY
"${compose[@]}" exec -T app sh -c 'set -eu; umask 077; trap "rm -f /tmp/release-setup.token" EXIT; cat > /tmp/release-setup.token; cd /app/apps/api; GLASSHOUSE_LOCAL_BOOTSTRAP_TOKEN_FILE=/tmp/release-setup.token bun run auth:provision-bootstrap' < "$work/setup.token"
# Production requires HTTPS; this ephemeral edge terminates TLS for the real image.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/key.pem" -out "$work/cert.pem" -days 1 -subj '/CN=127.0.0.1' >/dev/null 2>&1
bun "$root/infra/scripts/release-test-proxy.mjs" "$work/key.pem" "$work/cert.pem" &
proxy_pid=$!
curl --insecure --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 https://127.0.0.1:34763/v1/health >/dev/null
(cd "$root/apps/web" && RELEASE_SETUP_SECRET_FILE="$work/setup.token" PLAYWRIGHT_RELEASE_IMAGE=true bunx --no-install playwright test)
curl --insecure --fail --silent --show-error "$base/" > "$work/index.html"
asset="$(python3 - "$work/index.html" <<'PY'
import re,sys
html=open(sys.argv[1]).read()
assert '<div id="root"></div>' in html
matches=re.findall(r'<script[^>]+src="(/assets/[^\"]+\.js)"', html)
assert len(matches)==1
print(matches[0])
PY
)"
curl --insecure --fail --silent --show-error "$base$asset" > "$work/asset.js"
test -s "$work/asset.js"
curl --insecure --fail --silent --show-error "$base/v1/health" >/dev/null
test "$(curl --insecure --silent --output /dev/null --write-out '%{http_code}' "$base/v1/projects")" = 401
curl --insecure --fail --silent --show-error --cookie-jar "$work/cookies" -H 'content-type: application/json' --data '{"username":"release-admin","password":"synthetic-browser-password"}' "$base/v1/auth/login" >/dev/null
curl --insecure --fail --silent --show-error --cookie "$work/cookies" "$base/v1/projects" > "$work/projects.json"
project_id="$(python3 - "$work/projects.json" <<'PY'
import json,sys
ids=[item['id'] for item in json.load(open(sys.argv[1]))['items'] if item['slug']=='default']
assert len(ids)==1
print(ids[0])
PY
)"
set +e
curl --insecure --silent --show-error --fail --no-buffer --max-time 8 --cookie "$work/cookies" "$base/v1/traces/events?project_id=$project_id" > "$work/stream"
status=$?
set -e
test "$status" = 28
python3 - "$work/stream" <<'PY'
import sys
assert ':ok' in open(sys.argv[1]).read()
PY
test "$archive_hash" = "$(sha256sum "$archive")"
printf 'Exported image passed release-bundle integration.\n'
