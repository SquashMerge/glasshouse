#!/usr/bin/env bash
# Disposable stack: use either a locally built pair or the publisher's prebuilt
# candidates, then run the copied bundle with all application builds off.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
if revision="$(git rev-parse HEAD 2>/dev/null)"; then
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    test "$revision" = "${GITHUB_SHA:?GITHUB_SHA is required in Actions}"
  fi
elif [[ -z "${GITHUB_ACTIONS:-}" && -n "${IMAGE_TEST_REVISION:-}" ]]; then
  # The publisher tests an admitted archive with its scrubbed child environment;
  # caller assertions are never accepted directly by hosted CI as trace evidence.
  revision="$IMAGE_TEST_REVISION"
  printf 'Warning: source revision supplied by caller, not verified by Git\n' >&2
else
  printf 'Cannot determine source revision from Git\n' >&2
  exit 1
fi
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
if ! command -v docker >/dev/null; then
  printf 'Docker CLI and a reachable daemon are required for this integration test\n' >&2
  exit 1
fi
if [[ -n "${IMAGE_TEST_API:-}${IMAGE_TEST_WEB:-}" ]]; then
  : "${IMAGE_TEST_API:?both prebuilt images required}" "${IMAGE_TEST_WEB:?both prebuilt images required}"
fi
project="image-ci-$(python3 -c 'import secrets; print(secrets.token_hex(8))')"
tmp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/glasshouse-image-ci.XXXXXXXX")"
api_image="${IMAGE_TEST_API:-glasshouse-image-test-api:${revision}-${project}}"
web_image="${IMAGE_TEST_WEB:-glasshouse-image-test-web:${revision}-${project}}"
cp -R deploy/snapshot/. "$tmp/"
cp infra/scripts/image-integration/{compose.test.yaml,proxy.conf} "$tmp/"
cat > "$tmp/test.env" <<EOF
POSTGRES_USER=glasshouse_ci
POSTGRES_PASSWORD=synthetic-postgres-4f61cba90d
POSTGRES_DB=glasshouse_ci
CLICKHOUSE_USER=glasshouse_ci
CLICKHOUSE_PASSWORD=synthetic-clickhouse-6c70a4ed
CLICKHOUSE_DB=glasshouse_ci
VALKEY_PASSWORD=synthetic-valkey-8f71b2c0ad
UI_USERNAME=synthetic-owner
UI_PASSWORD=synthetic-ui-9b412e8cfa
GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME=synthetic-owner
GLASSHOUSE_PUBLIC_ORIGIN=https://glasshouse.example.invalid
GLASSHOUSE_AUTH_BOOTSTRAP_MODE=basic
GEPA_ALLOWED_MODELS=openai/gpt-4o-mini
GEPA_WORKER_MODE=gepa
GLASSHOUSE_API_IMAGE=$api_image
GLASSHOUSE_WEB_IMAGE=$web_image
EOF
chmod 600 "$tmp/test.env"
# Environment overrides must not replace the synthetic file's Compose values.
set -a
# shellcheck disable=SC1091
source "$tmp/test.env"
set +a
compose=(docker compose --project-directory "$tmp" --env-file "$tmp/test.env" --project-name "$project" -f "$tmp/compose.yaml" -f "$tmp/compose.test.yaml")
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    "${compose[@]}" ps --all || true
    "${compose[@]}" logs --no-color --tail=100 || true
  fi
  # Only the randomly named disposable CI project is ever removed.
  "${compose[@]}" down --volumes --remove-orphans || true
  # Prebuilt references belong to the caller; only remove our generated tags.
  if [[ -z "${IMAGE_TEST_API:-}" ]]; then
    docker image rm "$api_image" "$web_image" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$tmp"
  exit "$status"
}
trap cleanup EXIT

expected_pg="$(find infra/db/migrations -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')"
expected_ch="$(find infra/db/clickhouse -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')"
for component in api web; do
  image_var="${component}_image"
  image="${!image_var}"
  if [[ -z "${IMAGE_TEST_API:-}" ]]; then
    docker build --platform linux/amd64 --label "org.opencontainers.image.revision=$revision" -f "apps/$component/Dockerfile" -t "$image" .
  fi
  test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")" = "$revision"
  printf '%s image %s revision %s\n' "$component" "$(docker image inspect --format '{{.Id}}' "$image")" "$revision"
done

# Verify the actual rendered project has no host-published ports or build keys.
"${compose[@]}" --profile probe config --format json > "$tmp/rendered.json"
python3 - "$tmp/rendered.json" <<'PY'
import json, sys
with open(sys.argv[1]) as file:
    config = json.load(file)
assert set(config['services']) == {'postgres', 'clickhouse', 'valkey', 'api', 'web', 'proxy', 'probe'}
for name, service in config['services'].items():
    assert not service.get('ports'), f'{name} unexpectedly publishes ports'
    assert not service.get('build'), f'{name} unexpectedly builds'
PY
"${compose[@]}" --profile probe pull postgres clickhouse valkey proxy probe
"${compose[@]}" up --detach --no-build --pull never --wait --wait-timeout 240 postgres clickhouse valkey api web proxy
for component in api web; do
  image_var="${component}_image"
  container="$("${compose[@]}" ps -q "$component")"
  test "$(docker inspect --format '{{.Image}}' "$container")" = "$(docker image inspect --format '{{.Id}}' "${!image_var}")"
done

migrations() {
  pg="$("${compose[@]}" exec -T postgres psql -U glasshouse_ci -d glasshouse_ci -Atqc 'SELECT count(*) FROM pgmigrations')"
  ch="$("${compose[@]}" exec -T clickhouse clickhouse-client --user glasshouse_ci --password synthetic-clickhouse-6c70a4ed --database glasshouse_ci --query 'SELECT count() FROM glasshouse_schema_migrations')"
  test "$pg" = "$expected_pg"
  test "$ch" = "$expected_ch"
  "${compose[@]}" exec -T postgres psql -U glasshouse_ci -d glasshouse_ci -Atqc 'SELECT name FROM pgmigrations ORDER BY name'
  "${compose[@]}" exec -T clickhouse clickhouse-client --user glasshouse_ci --password synthetic-clickhouse-6c70a4ed --database glasshouse_ci --query 'SELECT * FROM glasshouse_schema_migrations ORDER BY 1 FORMAT TabSeparated'
}
migrations > "$tmp/migrations-before"
"${compose[@]}" restart api
"${compose[@]}" up --detach --no-deps --no-build --pull never --wait --wait-timeout 240 api
migrations > "$tmp/migrations-after"
cmp "$tmp/migrations-before" "$tmp/migrations-after"

probe() { "${compose[@]}" run --rm --no-deps probe "$@"; }
probe --silent --show-error --fail http://proxy:8080/ > "$tmp/web.html"
python3 - "$tmp/web.html" <<'PY'
import sys
assert '<div id="root"></div>' in open(sys.argv[1]).read()
PY
probe --silent --show-error --fail http://proxy:8080/health > /dev/null
probe --silent --show-error --fail http://proxy:8080/v1/health > /dev/null
status="$(probe --silent --show-error -o /dev/null -w '%{http_code}' http://proxy:8080/v1/projects)"
test "$status" = 401
probe --silent --show-error --fail --user synthetic-owner:synthetic-ui-9b412e8cfa http://proxy:8080/v1/projects > "$tmp/projects.json"
project_id="$(python3 - "$tmp/projects.json" <<'PY'
import json, sys
projects = json.load(open(sys.argv[1]))['items']
matching = [p['id'] for p in projects if p['slug'] == 'default']
assert len(matching) == 1
print(matching[0])
PY
)"
probe --silent --show-error --fail --user synthetic-owner:synthetic-ui-9b412e8cfa http://proxy:8080/openapi.json > "$tmp/openapi.json"
python3 - "$tmp/openapi.json" <<'PY'
import json,sys
assert '/v1/projects' in json.load(open(sys.argv[1]))['paths']
PY
probe --silent --show-error --fail --user synthetic-owner:synthetic-ui-9b412e8cfa http://proxy:8080/reference > "$tmp/reference.html"
python3 - "$tmp/reference.html" <<'PY'
import sys
assert 'openapi.json' in open(sys.argv[1]).read()
PY
[[ "$project_id" =~ ^[0-9a-f-]{36}$ ]]
# curl exits 28 on the expected timeout after receiving the first SSE frame.
set +e
probe --silent --show-error --fail --no-buffer --max-time 8 --user synthetic-owner:synthetic-ui-9b412e8cfa "http://proxy:8080/v1/traces/events?project_id=$project_id" > "$tmp/stream"
stream_status=$?
set -e
test "$stream_status" = 28
python3 - "$tmp/stream" <<'PY'
import sys
assert ':ok' in open(sys.argv[1]).read()
PY
printf 'Image bundle migrations, restart, health, authentication, proxy routes and SSE passed for %s\n' "$revision"
