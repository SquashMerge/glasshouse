#!/usr/bin/env bash
# Exercise the real backup entrypoint against disposable, distinguishable stores.
set -euo pipefail
umask 077
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/glasshouse-source-routing.XXXXXXXX")"
project="source-routing-$(basename "$tmp" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
compose=(docker compose --project-directory "$tmp" --env-file "$tmp/empty.env" --project-name "$project" -f "$tmp/compose.yaml")
cleanup() {
    local status=$?
    if (( status != 0 )); then
        "${compose[@]}" logs --no-color --tail=50 source-pg source-ch decoy >&2 || true
    fi
    "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    rm -rf -- "$tmp"
}
trap cleanup EXIT
: > "$tmp/empty.env"
cat > "$tmp/pg_service.conf" <<'CONF'
[hostile]
host=decoy
port=5432
CONF
chmod 644 "$tmp/pg_service.conf"
cat > "$tmp/compose.yaml" <<YAML
services:
  source-pg-init:
    image: postgres:18.6-alpine
    environment:
      POSTGRES_USER: fixture
      POSTGRES_PASSWORD: fixture-password
      POSTGRES_DB: fixture
    volumes:
      - pg-data:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin pg_isready -h /var/run/postgresql -p 5432 -U fixture -d fixture"]
      interval: 2s
      timeout: 3s
      retries: 60
  source-pg:
    image: postgres:18.6-alpine
    environment:
      POSTGRES_USER: fixture
      POSTGRES_PASSWORD: fixture-password
      POSTGRES_DB: fixture
      PGHOST: \${ROUTING_HOST:-}
      PGHOSTADDR: \${DECOY_IP:-}
      PGSERVICE: \${ROUTING_SERVICE:-}
      PGSERVICEFILE: /fixture/pg_service.conf
    volumes:
      - pg-data:/var/lib/postgresql
      - $tmp/pg_service.conf:/fixture/pg_service.conf:ro
    healthcheck:
      test: ["CMD-SHELL", "env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin pg_isready -h /var/run/postgresql -p 5432 -U fixture -d fixture"]
      interval: 2s
      timeout: 3s
      retries: 60
  decoy:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: fixture
      POSTGRES_PASSWORD: fixture-password
      POSTGRES_DB: fixture
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h /var/run/postgresql -U fixture -d fixture"]
      interval: 2s
      timeout: 3s
      retries: 60
  source-ch:
    image: clickhouse/clickhouse-server:26.10.2.103-alpine
    environment:
      CLICKHOUSE_USER: fixture
      CLICKHOUSE_PASSWORD: fixture-password
      CLICKHOUSE_DB: fixture
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: 1
    volumes:
      - ch-data:/var/lib/clickhouse
      - $root_dir/infra/clickhouse/backup.xml:/etc/clickhouse-server/config.d/glasshouse-backup.xml:ro
    ulimits:
      nofile: {soft: 262144, hard: 262144}
    healthcheck:
      test: ["CMD-SHELL", "clickhouse-client --user fixture --password fixture-password --query 'SELECT 1'"]
      interval: 2s
      timeout: 3s
      retries: 90
volumes:
  pg-data:
  ch-data:
YAML
# Initialize the source without routing settings, then restart it with hostile settings.
"${compose[@]}" up -d --wait --wait-timeout 180 source-pg-init decoy source-ch
"${compose[@]}" stop source-pg-init
decoy_id="$("${compose[@]}" ps -q decoy)"
export DECOY_IP="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$decoy_id")"
[[ -n "$DECOY_IP" ]]
export ROUTING_HOST=decoy ROUTING_SERVICE=hostile
"${compose[@]}" up -d --wait --wait-timeout 180 --force-recreate source-pg
source_id="$("${compose[@]}" ps -q source-pg)"
pg_local() {
    docker exec "$1" sh -ec 'exec env -i PATH="$PATH" PGPASSWORD=fixture-password psql -X -h /var/run/postgresql -p 5432 -U fixture -d fixture -v ON_ERROR_STOP=1 "$@"' sh "${@:2}"
}
pg_local "$source_id" -c "CREATE TABLE source_marker (marker text); INSERT INTO source_marker VALUES ('SOURCE_ONLY_MARKER');"
pg_local "$decoy_id" -c "CREATE TABLE decoy_marker (marker text); INSERT INTO decoy_marker VALUES ('DECOY_ONLY_MARKER');"
source_version="$(pg_local "$source_id" -Atc "SELECT current_setting('server_version')")"
decoy_version="$(pg_local "$decoy_id" -Atc "SELECT current_setting('server_version')")"
printf 'Source PostgreSQL version: %s; decoy version: %s\n' "$source_version" "$decoy_version"
[[ "$source_version" != "$decoy_version" ]] || { printf 'Fixture versions are not distinguishable\n' >&2; exit 1; }
# Confirm the actual inherited libpq settings route an unguarded client to decoy.
observed="$(docker exec -e PGPASSWORD=fixture-password "$source_id" psql -X -At -U fixture -d fixture -c "SELECT current_setting('server_version')")"
[[ "$observed" == "$decoy_version" ]] || { printf 'Hostile libpq fixture did not reach decoy\n' >&2; exit 1; }
"${compose[@]}" exec -T source-ch clickhouse-client --user fixture --password fixture-password --query "CREATE TABLE fixture.source_ch_marker (value String) ENGINE = MergeTree ORDER BY tuple()"
"${compose[@]}" exec -T source-ch clickhouse-client --user fixture --password fixture-password --query "INSERT INTO fixture.source_ch_marker VALUES ('SOURCE_CH_MARKER')"
BACKUP_SOURCE_COMPOSE_FILE="$tmp/compose.yaml" BACKUP_SOURCE_ENV_FILE="$tmp/empty.env" \
BACKUP_SOURCE_COMPOSE_PROJECT="$project" BACKUP_POSTGRES_SERVICE=source-pg BACKUP_CLICKHOUSE_SERVICE=source-ch \
BACKUP_SOURCE_ID=fixture-source BACKUP_DESTINATION="$tmp/artifacts" BACKUP_ID=route \
    bash "$root_dir/infra/scripts/backup.sh"
artifact="$tmp/artifacts/route"
docker exec -i "$source_id" pg_restore --file=- --no-owner --no-privileges < "$artifact/postgres.dump" > "$tmp/dump.sql"
python3 - "$artifact" "$tmp/dump.sql" "$source_version" "$project" <<'PY'
import json, pathlib, sys, zipfile
artifact, dump, source_version, project = sys.argv[1:]
artifact = pathlib.Path(artifact)
sql = pathlib.Path(dump).read_text()
manifest = json.loads((artifact / 'manifest.json').read_text())
errors = []
if 'SOURCE_ONLY_MARKER' not in sql or 'DECOY_ONLY_MARKER' in sql:
    errors.append('PostgreSQL archive routed to decoy instead of source')
if manifest['postgres_server_version'] != source_version:
    errors.append('Manifest PostgreSQL version is not the source server version')
if manifest['source_compose_project'] != project or manifest['source_id'] != 'fixture-source':
    errors.append('Manifest source identity is incorrect')
with zipfile.ZipFile(artifact / 'clickhouse.zip') as z:
    if not any('source_ch_marker' in name for name in z.namelist()):
        errors.append('ClickHouse archive does not contain source marker table')
if errors:
    raise SystemExit('\n'.join(errors))
print('Source routing regression passed: source dump and version, not decoy, and source ClickHouse archive')
PY
