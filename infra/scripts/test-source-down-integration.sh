#!/usr/bin/env bash
# Disposable real-store regression. Both projects use the SAME local daemon:
# only the private fixture's manifest identity is synthetic, not proof of two hosts.
set -euo pipefail
umask 077
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root_dir/infra/scripts/backup-restore-common.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/glasshouse-source-down.XXXXXXXX")"
suffix="$(python3 -c 'import secrets; print(secrets.token_hex(8))')"
source_project="gh-source-down-s-$suffix"
target_project="gh-source-down-t-$suffix"
shared_container="gh-source-down-shared-$suffix"
# Pin all Compose and datastore settings; inherited CI/operator values must not
# select existing services, images, projects, or credentials.
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR
export POSTGRES_USER=synthetic POSTGRES_PASSWORD=synthetic_source_down_password POSTGRES_DB=glasshouse
export CLICKHOUSE_USER=synthetic CLICKHOUSE_PASSWORD=synthetic_source_down_password CLICKHOUSE_DB=glasshouse
mkdir -p "$work/target" "$work/artifacts"
# Never create or remove resources on a remote Docker endpoint.
endpoint="${DOCKER_HOST:-$(docker context inspect "${DOCKER_CONTEXT:-$(docker context show)}" --format '{{.Endpoints.docker.Host}}')}"
if [[ "$endpoint" != unix:///* ]]; then
    rm -rf -- "$work"
    printf 'A local Unix Docker endpoint is required for this regression\n' >&2; exit 1
fi
cp "$root_dir/.github/compose.backup-restore.yaml" "$work/compose.yaml"
python3 - "$work/compose.yaml" "$root_dir/infra/clickhouse/backup.xml" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
old = './infra/clickhouse/backup.xml:/etc/clickhouse-server/config.d/glasshouse-backup.xml:ro'
assert s.count(old) == 1
p.write_text(s.replace(old, sys.argv[2] + ':/etc/clickhouse-server/config.d/glasshouse-backup.xml:ro'))
PY
printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\nCLICKHOUSE_USER=%s\nCLICKHOUSE_PASSWORD=%s\nCLICKHOUSE_DB=%s\n' "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$POSTGRES_DB" "$CLICKHOUSE_USER" "$CLICKHOUSE_PASSWORD" "$CLICKHOUSE_DB" > "$work/test.env"
source_compose=(docker compose --project-directory "$root_dir" --env-file "$work/test.env" --project-name "$source_project" -f "$work/compose.yaml")
target_compose=(docker compose --project-directory "$work/target" --env-file "$work/test.env" --project-name "$target_project" -f "$work/compose.yaml")
cleanup() {
    docker rm -f "$shared_container" >/dev/null 2>&1 || true
    "${source_compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    "${target_compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    if [[ -d "$work/pg-outside" ]]; then
        docker run --rm --user root --mount "type=bind,source=$work/pg-outside,target=/data" --entrypoint chown postgres:18.6-alpine -R "$(id -u):$(id -g)" /data >/dev/null 2>&1 || true
    fi
    rm -rf -- "$work"
}
trap cleanup EXIT
# Ensure even a collision cannot adopt and later delete someone else's project.
for project in "$source_project" "$target_project"; do
    if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]] ||
       docker volume inspect "${project}_postgres-data" >/dev/null 2>&1 ||
       docker volume inspect "${project}_clickhouse-data" >/dev/null 2>&1 ||
       docker network inspect "${project}_default" >/dev/null 2>&1; then
        trap - EXIT
        rm -rf -- "$work"
        printf 'Refusing project name collision\n' >&2; exit 1
    fi
done
if docker container inspect "$shared_container" >/dev/null 2>&1; then
    trap - EXIT
    rm -rf -- "$work"
    printf 'Refusing container name collision\n' >&2; exit 1
fi
"${source_compose[@]}" up --detach --wait --wait-timeout 180 postgres clickhouse
"${target_compose[@]}" up --detach --wait --wait-timeout 180 postgres clickhouse
source_ch_config="$(create_clickhouse_client_config clickhouse "$CLICKHOUSE_USER" "$CLICKHOUSE_PASSWORD" "${source_compose[@]}")"
PGPASSWORD="$POSTGRES_PASSWORD" "${source_compose[@]}" exec -T -e PGPASSWORD postgres psql --no-password -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE TABLE recovery_probe (id text PRIMARY KEY, payload text NOT NULL); INSERT INTO recovery_probe VALUES ('source-down', 'postgres-recovered');" >/dev/null
"${source_compose[@]}" exec -T clickhouse clickhouse-client --config-file "$source_ch_config" --database "$CLICKHOUSE_DB" --query "CREATE TABLE recovery_probe (id String, payload String) ENGINE=MergeTree ORDER BY id; INSERT INTO recovery_probe VALUES ('source-down', 'clickhouse-recovered')" >/dev/null
remove_clickhouse_client_config clickhouse "$source_ch_config" "${source_compose[@]}"
export BACKUP_SOURCE_COMPOSE_FILE="$work/compose.yaml" BACKUP_SOURCE_ENV_FILE="$work/test.env" BACKUP_SOURCE_COMPOSE_PROJECT="$source_project"
export BACKUP_POSTGRES_SERVICE=postgres BACKUP_CLICKHOUSE_SERVICE=clickhouse
BACKUP_DESTINATION="$work/artifacts" BACKUP_SOURCE_ID=synthetic-source BACKUP_ID=fixture "$root_dir/infra/scripts/backup.sh"
artifact="$work/artifacts/fixture"
actual_daemon="$(docker info --format '{{.ID}}')"
python3 - "$artifact/manifest.json" "$actual_daemon" "$source_project" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
assert sys.argv[2] and sys.argv[2] != '<no value>'
assert m['source_docker_daemon_id'] == sys.argv[2]
assert m['source_compose_project'] == sys.argv[3]
PY
"${source_compose[@]}" down --volumes --remove-orphans
[[ -z "$("${source_compose[@]}" ps -aq)" ]]
# No source Compose configuration is available to restore either.
export BACKUP_SOURCE_COMPOSE_FILE="$work/unavailable-source.yaml" BACKUP_SOURCE_ENV_FILE="$work/unavailable-source.env"
export BACKUP_ARTIFACT="$artifact" RESTORE_TARGET_DIRECTORY="$work/target" RESTORE_TARGET_COMPOSE_FILE="$work/compose.yaml" RESTORE_TARGET_ENV_FILE="$work/test.env" RESTORE_TARGET_COMPOSE_PROJECT="$target_project"
export RESTORE_TARGET_ID=synthetic-target RESTORE_CONFIRMATION='RESTORE GLASSHOUSE TO synthetic-target' RESTORE_TARGET_LIVE=false RESTORE_TRUSTED_ARTIFACT='I TRUST THIS BACKUP'
export RESTORE_SOURCE_UNAVAILABLE=true RESTORE_SOURCE_UNAVAILABLE_CONFIRMATION='SOURCE IS UNAVAILABLE' RESTORE_DISTINCT_HOST_CONFIRMATION='I VERIFIED DISTINCT HOST' RESTORE_DISTINCT_STORAGE_CONFIRMATION='I VERIFIED DISTINCT STORAGE'
export RESTORE_POSTGRES_SERVICE=postgres RESTORE_CLICKHOUSE_SERVICE=clickhouse
expect_refusal() {
    local label="$1" message="$2"; shift 2
    if env "$@" "$root_dir/infra/scripts/restore.sh" >"$work/refusal.log" 2>&1; then
        printf 'Unexpected restore success: %s\n' "$label" >&2; exit 1
    fi
    if ! grep -Fq "$message" "$work/refusal.log"; then
        printf 'Wrong refusal for %s (expected %s)\n' "$label" "$message" >&2
        cat "$work/refusal.log" >&2; exit 1
    fi
    printf 'Verified refusal: %s\n' "$label"
}
expect_refusal 'actual same daemon' 'source and target Docker daemon IDs must differ'
cp "$artifact/manifest.json" "$work/manifest.original"
python3 - "$artifact/manifest.json" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]); m = json.loads(p.read_text())
del m['source_docker_daemon_id']
p.write_text(json.dumps(m) + '\n')
PY
expect_refusal 'older backup missing daemon metadata' 'source Docker daemon and Compose project metadata'
cp "$work/manifest.original" "$artifact/manifest.json"
# This one fixture-only mutation emulates independently authenticated source
# metadata; the real source and target were on the SAME host and daemon.
python3 - "$artifact/manifest.json" "$actual_daemon" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]); m = json.loads(p.read_text())
m['source_docker_daemon_id'] = 'synthetic-distinct-source-daemon'
assert m['source_docker_daemon_id'] != sys.argv[2]
p.write_text(json.dumps(m) + '\n')
PY
for var in RESTORE_SOURCE_UNAVAILABLE_CONFIRMATION RESTORE_DISTINCT_HOST_CONFIRMATION RESTORE_DISTINCT_STORAGE_CONFIRMATION; do
    expect_refusal "missing $var" 'confirmations are required' -u "$var"
    expect_refusal "incorrect $var" 'confirmations are required' "$var=wrong"
done
expect_refusal 'untrusted artifact' 'verify provenance' -u RESTORE_TRUSTED_ARTIFACT
expect_refusal 'same project' 'source and target Compose projects must differ' "RESTORE_TARGET_COMPOSE_PROJECT=$source_project"
# A stopped unrelated container still makes a target volume unsafe.
docker create --name "$shared_container" --mount "type=volume,source=${target_project}_postgres-data,target=/attached" postgres:18.6-alpine true >/dev/null
expect_refusal 'volume attached to another stopped container' 'data volume attached to another container'
docker rm "$shared_container" >/dev/null
# An apparently dedicated volume does not prove that PostgreSQL uses it.
# Recreate only this disposable target with PGDATA in the writable layer.
python3 - "$work/compose.yaml" "$work/outside.yaml" <<'PY'
from pathlib import Path
import sys
s = Path(sys.argv[1]).read_text()
s = s.replace('      POSTGRES_USER: ${POSTGRES_USER:?POSTGRES_USER is required}',
              '      PGDATA: /tmp/outside-pgdata\n      POSTGRES_USER: ${POSTGRES_USER:?POSTGRES_USER is required}', 1)
Path(sys.argv[2]).write_text(s)
PY
outside_compose=(docker compose --project-directory "$work/target" --env-file "$work/test.env" --project-name "$target_project" -f "$work/outside.yaml")
"${outside_compose[@]}" up --detach --wait --wait-timeout 180 postgres
expect_refusal 'PostgreSQL data outside dedicated volume' 'PostgreSQL data directory' "RESTORE_TARGET_COMPOSE_FILE=$work/outside.yaml"
outside_result="$(PGPASSWORD="$POSTGRES_PASSWORD" "${outside_compose[@]}" exec -T -e PGPASSWORD postgres psql --no-password -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT to_regclass('public.recovery_probe') IS NULL")"
[[ "$outside_result" == t ]]
# Repeat with the actual data directory on a separate bind mount.
mkdir "$work/pg-outside"
python3 - "$work/outside.yaml" "$work/outside-bind.yaml" "$work/pg-outside" <<'PY'
from pathlib import Path
import sys
s = Path(sys.argv[1]).read_text()
old = '      - postgres-data:/var/lib/postgresql'
assert s.count(old) == 1
Path(sys.argv[2]).write_text(s.replace(old, old + '\n      - ' + sys.argv[3] + ':/tmp/outside-pgdata'))
PY
bind_compose=(docker compose --project-directory "$work/target" --env-file "$work/test.env" --project-name "$target_project" -f "$work/outside-bind.yaml")
"${bind_compose[@]}" up --detach --wait --wait-timeout 180 postgres
expect_refusal 'PostgreSQL data on outside bind mount' 'PostgreSQL data directory' "RESTORE_TARGET_COMPOSE_FILE=$work/outside-bind.yaml"
[[ "$(PGPASSWORD="$POSTGRES_PASSWORD" "${bind_compose[@]}" exec -T -e PGPASSWORD postgres psql --no-password -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT to_regclass('public.recovery_probe') IS NULL")" == t ]]
"${target_compose[@]}" up --detach --wait --wait-timeout 180 postgres
# Also reject a running ClickHouse whose server path is outside its volume.
printf '<clickhouse><path>/tmp/outside-clickhouse/</path></clickhouse>\n' > "$work/ch-outside.xml"
chmod 644 "$work/ch-outside.xml"
python3 - "$work/compose.yaml" "$work/ch-outside.yaml" "$work/ch-outside.xml" <<'PY'
from pathlib import Path
import sys
s = Path(sys.argv[1]).read_text()
old = '      - clickhouse-data:/var/lib/clickhouse'
assert s.count(old) == 1
s = s.replace(old, old + '\n      - ' + sys.argv[3] + ':/etc/clickhouse-server/config.d/outside.xml:ro')
Path(sys.argv[2]).write_text(s)
PY
outside_ch_compose=(docker compose --project-directory "$work/target" --env-file "$work/test.env" --project-name "$target_project" -f "$work/ch-outside.yaml")
"${outside_ch_compose[@]}" up --detach --wait --wait-timeout 180 clickhouse
expect_refusal 'ClickHouse data outside dedicated volume' 'ClickHouse data paths or disks' "RESTORE_TARGET_COMPOSE_FILE=$work/ch-outside.yaml"
ch_outside_config="$(create_clickhouse_client_config clickhouse "$CLICKHOUSE_USER" "$CLICKHOUSE_PASSWORD" "${outside_ch_compose[@]}")"
[[ "$("${outside_ch_compose[@]}" exec -T clickhouse clickhouse-client --config-file "$ch_outside_config" --database "$CLICKHOUSE_DB" --query="SELECT count() FROM system.tables WHERE database = '$CLICKHOUSE_DB' AND name = 'recovery_probe'")" == 0 ]]
remove_clickhouse_client_config clickhouse "$ch_outside_config" "${outside_ch_compose[@]}"
[[ "$(PGPASSWORD="$POSTGRES_PASSWORD" "${target_compose[@]}" exec -T -e PGPASSWORD postgres psql --no-password -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT to_regclass('public.recovery_probe') IS NULL")" == t ]]
"${target_compose[@]}" up --detach --wait --wait-timeout 180 clickhouse
PGPASSWORD="$POSTGRES_PASSWORD" "${target_compose[@]}" exec -T -e PGPASSWORD postgres psql --no-password -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'CREATE TABLE unsafe_existing_target (id int)' >/dev/null
expect_refusal 'non-empty target' 'target data stores are not empty'
PGPASSWORD="$POSTGRES_PASSWORD" "${target_compose[@]}" exec -T -e PGPASSWORD postgres psql --no-password -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'DROP TABLE unsafe_existing_target' >/dev/null
# Start a second real, empty server on the test network; inherited libpq
# variables must not divert any validation or restore operation to it.
docker run -d --name "$shared_container" --network "${target_project}_default" \
    -e POSTGRES_USER -e POSTGRES_PASSWORD -e POSTGRES_DB postgres:18.6-alpine >/dev/null
for attempt in {1..60}; do
    if docker exec "$shared_container" pg_isready -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then break; fi
    sleep 1
done
docker exec "$shared_container" pg_isready -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
alternate_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$shared_container")"
python3 - "$work/compose.yaml" "$work/hostile.yaml" "$alternate_ip" <<'PY'
from pathlib import Path
import sys
s = Path(sys.argv[1]).read_text()
s = s.replace('      POSTGRES_USER: ${POSTGRES_USER:?POSTGRES_USER is required}',
              '      PGHOST: hostile-alias\n      PGHOSTADDR: ' + sys.argv[3] + '\n      PGSERVICE: nonexistent\n      PGSERVICEFILE: /tmp/nonexistent-service\n      POSTGRES_USER: ${POSTGRES_USER:?POSTGRES_USER is required}', 1)
s = s.replace('pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}',
              'env -i PATH=/usr/local/bin:/usr/bin:/bin pg_isready -h /var/run/postgresql -p 5432 -U $${POSTGRES_USER} -d $${POSTGRES_DB}', 1)
Path(sys.argv[2]).with_name('hostile-service.conf').write_text('[hostile]\nhost=hostile-alias\nhostaddr=' + sys.argv[3] + '\nport=5432\n')
s = s.replace('      PGHOST: hostile-alias\n      PGHOSTADDR: ' + sys.argv[3] + '\n      PGSERVICE: nonexistent\n      PGSERVICEFILE: /tmp/nonexistent-service',
              '      PGHOST: hostile-alias\n      PGHOSTADDR: ' + sys.argv[3] + '\n      PGSERVICE: hostile\n      PGSERVICEFILE: /tmp/hostile-service.conf')
s = s.replace('      - postgres-data:/var/lib/postgresql',
              '      - postgres-data:/var/lib/postgresql\n      - ' + str(Path(sys.argv[2]).with_name('hostile-service.conf')) + ':/tmp/hostile-service.conf:ro', 1)
Path(sys.argv[2]).write_text(s)
PY
hostile_compose=(docker compose --project-directory "$work/target" --env-file "$work/test.env" --project-name "$target_project" -f "$work/hostile.yaml")
"${hostile_compose[@]}" up --detach --wait --wait-timeout 180 postgres
hostile_psql() {
    PGPASSWORD="$POSTGRES_PASSWORD" "${hostile_compose[@]}" exec -T -e PGPASSWORD postgres sh -c \
        'exec env -i PATH=/usr/local/bin:/usr/bin:/bin PGPASSWORD="$PGPASSWORD" "$@"' sh \
        psql --no-password -h /var/run/postgresql -p 5432 -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"
}
hostile_psql -c 'CREATE TABLE unsafe_existing_target (id int)' >/dev/null
expect_refusal 'hostile libpq environment cannot bypass target emptiness' 'target data stores are not empty' "RESTORE_TARGET_COMPOSE_FILE=$work/hostile.yaml"
hostile_psql -c 'DROP TABLE unsafe_existing_target' >/dev/null
RESTORE_TARGET_COMPOSE_FILE="$work/hostile.yaml" "$root_dir/infra/scripts/restore.sh"
alternate_result="$(PGPASSWORD="$POSTGRES_PASSWORD" docker exec -e PGPASSWORD "$shared_container" psql --no-password -h /var/run/postgresql -p 5432 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT to_regclass('public.recovery_probe') IS NULL")"
[[ "$alternate_result" == t ]]
target_compose=("${hostile_compose[@]}")
target_ch_config="$(create_clickhouse_client_config clickhouse "$CLICKHOUSE_USER" "$CLICKHOUSE_PASSWORD" "${target_compose[@]}")"
pg_result="$(PGPASSWORD="$POSTGRES_PASSWORD" "${target_compose[@]}" exec -T -e PGPASSWORD postgres sh -c 'exec env -i PATH=/usr/local/bin:/usr/bin:/bin PGPASSWORD="$PGPASSWORD" "$@"' sh psql --no-password -h /var/run/postgresql -p 5432 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT payload FROM recovery_probe WHERE id = 'source-down'")"
ch_result="$("${target_compose[@]}" exec -T clickhouse clickhouse-client --config-file "$target_ch_config" --database "$CLICKHOUSE_DB" --query "SELECT payload FROM recovery_probe WHERE id = 'source-down'")"
remove_clickhouse_client_config clickhouse "$target_ch_config" "${target_compose[@]}"
[[ "$pg_result" == postgres-recovered && "$ch_result" == clickhouse-recovered ]]
printf 'Real PostgreSQL + ClickHouse source-down restore passed (synthetic source identity; same Docker host).\n'
