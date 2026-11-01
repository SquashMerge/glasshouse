#!/usr/bin/env bash
# Real operator/CI gate. It needs a running source stack and a separately
# provisioned, empty target stack with unique volumes.

set -euo pipefail
umask 077
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/backup-restore-common.sh"
destination="${BACKUP_RESTORE_DESTINATION:-$(mktemp -d)}"
backup_id="backup-restore-integration-$$"
probe="backup_restore_probe_$$"
source_compose_file="$(resolve_path "$root_dir" "${BACKUP_SOURCE_COMPOSE_FILE:-infra/compose.yaml}")"
source_env_file="$(resolve_path "$root_dir" "${BACKUP_SOURCE_ENV_FILE:-infra/.env}")"
source_project="${BACKUP_SOURCE_COMPOSE_PROJECT:-glasshouse}"
source_compose=(docker compose --project-directory "$root_dir" --env-file "$source_env_file" --project-name "$source_project" -f "$source_compose_file")
pg_service="${BACKUP_POSTGRES_SERVICE:-postgres}"
ch_service="${BACKUP_CLICKHOUSE_SERVICE:-clickhouse}"
pg_user="$(compose_service_value "$pg_service" POSTGRES_USER "${source_compose[@]}")"
pg_password="$(compose_service_value "$pg_service" POSTGRES_PASSWORD "${source_compose[@]}")"
pg_database="$(compose_service_value "$pg_service" POSTGRES_DB "${source_compose[@]}")"
ch_user="$(compose_service_value "$ch_service" CLICKHOUSE_USER "${source_compose[@]}")"
ch_password="$(compose_service_value "$ch_service" CLICKHOUSE_PASSWORD "${source_compose[@]}")"
ch_database="$(compose_service_value "$ch_service" CLICKHOUSE_DB "${source_compose[@]}")"
source_ch_client_config=""
target_ch_client_config=""
target_ch_service=""
target_compose=()

cleanup() {
	PGPASSWORD="$pg_password" "${source_compose[@]}" exec -T -e PGPASSWORD "$pg_service" psql --no-password --username="$pg_user" --dbname="$pg_database" --command="DROP TABLE IF EXISTS $probe" >/dev/null 2>&1 || true
	if [[ -n "$source_ch_client_config" ]]; then
		"${source_compose[@]}" exec -T "$ch_service" clickhouse-client --config-file "$source_ch_client_config" --database "$ch_database" --query="DROP TABLE IF EXISTS $probe" >/dev/null 2>&1 || true
		remove_clickhouse_client_config "$ch_service" "$source_ch_client_config" "${source_compose[@]}"
	fi
	if [[ -n "$target_ch_client_config" ]]; then
		remove_clickhouse_client_config "$target_ch_service" "$target_ch_client_config" "${target_compose[@]}"
	fi
}
trap cleanup EXIT
source_ch_client_config="$(create_clickhouse_client_config "$ch_service" "$ch_user" "$ch_password" "${source_compose[@]}")"

# Hosted Linux CI can reach its disposable Compose bridge IPs directly.
application_fixture() {
	local mode="$1" user="$2" password="$3" database="$4" ch_username="$5" ch_secret="$6" ch_db="$7"
	shift 7
	local pg_container ch_container pg_host ch_host database_url
	pg_container="$("$@" ps -q "$pg_service")"
	ch_container="$("$@" ps -q "$ch_service")"
	pg_host="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$pg_container")"
	ch_host="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$ch_container")"
	database_url="$(PGUSER="$user" PGPASSWORD="$password" PGDATABASE="$database" PGHOST="$pg_host" python3 -c 'import os; from urllib.parse import quote; print("postgres://" + quote(os.environ["PGUSER"], safe="") + ":" + quote(os.environ["PGPASSWORD"], safe="") + "@" + os.environ["PGHOST"] + ":5432/" + quote(os.environ["PGDATABASE"], safe=""))')"
	DATABASE_URL="$database_url" CLICKHOUSE_URL="http://$ch_host:8123" CLICKHOUSE_USER="$ch_username" CLICKHOUSE_PASSWORD="$ch_secret" CLICKHOUSE_DB="$ch_db" \
		bun run "$root_dir/apps/api/tests/fixtures/datastore-restore.ts" "$mode"
}

if [[ "${BACKUP_RESTORE_APPLICATION_FIXTURE:-0}" == 1 ]]; then
	application_fixture seed "$pg_user" "$pg_password" "$pg_database" "$ch_user" "$ch_password" "$ch_database" "${source_compose[@]}"
fi

PGPASSWORD="$pg_password" "${source_compose[@]}" exec -T -e PGPASSWORD "$pg_service" psql --no-password --set ON_ERROR_STOP=1 --username="$pg_user" --dbname="$pg_database" --command="CREATE TABLE $probe (organization_id uuid NOT NULL, project_id uuid NOT NULL, probe_id text PRIMARY KEY, payload jsonb NOT NULL); CREATE INDEX ${probe}_scope ON $probe (organization_id, project_id); INSERT INTO $probe VALUES ('43000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000002', 'issue-43', '{\"value\":\"representative-record\"}');" >/dev/null
"${source_compose[@]}" exec -T "$ch_service" clickhouse-client --config-file "$source_ch_client_config" --database "$ch_database" --query="CREATE TABLE $probe (organization_id String, project_id String, probe_id String, start_time DateTime64(3), payload String, metadata Map(String, String), INDEX payload_tokens payload TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4, CONSTRAINT tenant_scope CHECK notEmpty(organization_id) AND notEmpty(project_id)) ENGINE = MergeTree PARTITION BY toYYYYMM(start_time) ORDER BY (organization_id, project_id, probe_id); INSERT INTO $probe VALUES ('43000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000002', 'issue-43', '2026-10-30 00:00:00.123', 'representative-record', map('fixture', 'upgrade'))" >/dev/null

"${source_compose[@]}" exec -T "$ch_service" clickhouse-client --config-file "$source_ch_client_config" --database "$ch_database" --query="INSERT INTO $probe SELECT '43000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000002', concat('large-', toString(number)), toDateTime64('2026-10-30 00:00:00.123', 3), hex(MD5(toString(number))), map('fixture', 'large') FROM numbers(5000)" >/dev/null
PGPASSWORD="$pg_password" "${source_compose[@]}" exec -T -e PGPASSWORD "$pg_service" psql --no-password --set ON_ERROR_STOP=1 --username="$pg_user" --dbname="$pg_database" --command="INSERT INTO $probe SELECT '43000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000002', 'truncation-' || i, jsonb_build_object('value', md5(i::text)) FROM generate_series(1, 5000) i" >/dev/null
BACKUP_DESTINATION="$destination" BACKUP_SOURCE_ID=integration BACKUP_ID="$backup_id" "$root_dir/infra/scripts/backup.sh"
artifact="$destination/$backup_id"
# Record source identifiers at backup time for later target-side comparisons;
# the operator must authenticate the manifest and independently verify isolation.
source_daemon_id="$(docker info --format '{{.ID}}')"
python3 - "$artifact/manifest.json" "$source_daemon_id" "$source_project" <<'PY'
import json
import sys
with open(sys.argv[1]) as stream:
    manifest = json.load(stream)
if not sys.argv[2] or manifest.get("source_docker_daemon_id") != sys.argv[2]:
    raise SystemExit("backup must record the actual source Docker daemon ID")
if not sys.argv[3] or manifest.get("source_compose_project") != sys.argv[3]:
    raise SystemExit("backup must record the source Compose project")
PY
BACKUP_ARTIFACT="$artifact" "$root_dir/infra/scripts/restore.sh" --validate-only

target_env_file="$(resolve_path "$RESTORE_TARGET_DIRECTORY" "${RESTORE_TARGET_ENV_FILE:-infra/.env}")"
target_compose=(docker compose --project-directory "$RESTORE_TARGET_DIRECTORY" --env-file "$target_env_file" --project-name "$RESTORE_TARGET_COMPOSE_PROJECT" -f "$RESTORE_TARGET_COMPOSE_FILE")
target_pg_service="${RESTORE_POSTGRES_SERVICE:-postgres}"
target_ch_service="${RESTORE_CLICKHOUSE_SERVICE:-clickhouse}"
target_pg_user="$(compose_service_value "$target_pg_service" POSTGRES_USER "${target_compose[@]}")"
target_pg_password="$(compose_service_value "$target_pg_service" POSTGRES_PASSWORD "${target_compose[@]}")"
target_pg_database="$(compose_service_value "$target_pg_service" POSTGRES_DB "${target_compose[@]}")"
target_ch_user="$(compose_service_value "$target_ch_service" CLICKHOUSE_USER "${target_compose[@]}")"
target_ch_password="$(compose_service_value "$target_ch_service" CLICKHOUSE_PASSWORD "${target_compose[@]}")"
target_ch_database="$(compose_service_value "$target_ch_service" CLICKHOUSE_DB "${target_compose[@]}")"
target_ch_client_config="$(create_clickhouse_client_config "$target_ch_service" "$target_ch_user" "$target_ch_password" "${target_compose[@]}")"
target_pg_version="$(PGPASSWORD="$target_pg_password" "${target_compose[@]}" exec -T -e PGPASSWORD "$target_pg_service" psql --no-password --tuples-only --no-align --username="$target_pg_user" --dbname="$target_pg_database" --command="SELECT current_setting('server_version')" | tr -d '[:space:]')"
target_ch_version="$("${target_compose[@]}" exec -T "$target_ch_service" clickhouse-client --config-file "$target_ch_client_config" --query='SELECT version()' | tr -d '[:space:]')"
python3 - "$artifact/manifest.json" "$target_pg_version" "$target_ch_version" <<'PY'
import json
import sys

with open(sys.argv[1]) as stream:
    manifest = json.load(stream)
for key, version in zip(("postgres_server_version", "clickhouse_server_version"), sys.argv[2:]):
    if manifest.get(key) != version:
        raise SystemExit(f"current-version recovery probe requires matching source and target {key}")
PY
# A ZIP with a recomputed outer digest is not necessarily a native backup.
# Check both validation-only and actual restore before the target has data.
assert_targets_empty() {
    [[ "$(PGPASSWORD="$target_pg_password" "${target_compose[@]}" exec -T -e PGPASSWORD "$target_pg_service" psql --no-password -At --username="$target_pg_user" --dbname="$target_pg_database" --command="SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" == 0 ]]
    [[ "$("${target_compose[@]}" exec -T "$target_ch_service" clickhouse-client --config-file "$target_ch_client_config" --database "$target_ch_database" --query="SELECT count() FROM system.tables WHERE database = '$target_ch_database'")" == 0 ]]
}
bad_pg="$destination/${backup_id}-truncated-pg"
cp -a "$artifact" "$bad_pg"
# Find a cut in compressed table data, rather than the often-large TOC of a
# fully migrated source. Require that --list succeeds and a full render fails.
found_truncation=false
for percent in 99 95 90 80 70 60 50; do
    cp "$artifact/postgres.dump" "$bad_pg/postgres.dump"
    python3 - "$bad_pg/postgres.dump" "$percent" <<'PY'
import os, sys
with open(sys.argv[1], 'r+b') as stream:
    stream.truncate(os.fstat(stream.fileno()).st_size * int(sys.argv[2]) // 100)
PY
    if "${target_compose[@]}" exec -T -i "$target_pg_service" pg_restore --list < "$bad_pg/postgres.dump" >/dev/null 2>&1 &&
       ! "${target_compose[@]}" exec -T -i "$target_pg_service" pg_restore --exit-on-error --file=- < "$bad_pg/postgres.dump" >/dev/null 2>&1; then
        found_truncation=true
        break
    fi
done
[[ "$found_truncation" == true ]] || { printf 'fixture did not demonstrate list-versus-stream truncation\n' >&2; exit 1; }
(cd "$bad_pg" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
if BACKUP_ARTIFACT="$bad_pg" "$root_dir/infra/scripts/restore.sh" >"$destination/${backup_id}-truncated-pg.log" 2>&1; then
    printf 'truncated PostgreSQL archive accepted\n' >&2; exit 1
fi
if ! grep -q 'PostgreSQL archive failed validation' "$destination/${backup_id}-truncated-pg.log"; then
    printf 'truncated PostgreSQL archive did not fail before restore writes\n' >&2; exit 1
fi
assert_targets_empty
bad_zip="$destination/${backup_id}-fake-zip"
cp -a "$artifact" "$bad_zip"
python3 - "$bad_zip/clickhouse.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    archive.writestr('unrelated.txt', 'not a ClickHouse backup')
PY
(cd "$bad_zip" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
if BACKUP_ARTIFACT="$bad_zip" "$root_dir/infra/scripts/restore.sh" --validate-only >"$destination/${backup_id}-fake-zip.log" 2>&1; then
    printf 'unrelated ZIP accepted as native ClickHouse backup\n' >&2; exit 1
fi
if BACKUP_ARTIFACT="$bad_zip" "$root_dir/infra/scripts/restore.sh" >"$destination/${backup_id}-fake-restore.log" 2>&1; then
    printf 'unrelated ZIP restored\n' >&2; exit 1
fi
assert_targets_empty
# Rewrite ZIPs and outer SHA-256s while leaving their native metadata/parts
# inconsistent. ZIP CRCs are regenerated, so only native validation catches it.
for damage in missing-manifest malformed-manifest unsupported-version missing-part tampered-part tampered-metadata omitted-entry; do
    damaged="$destination/${backup_id}-ch-$damage"
    cp -a "$artifact" "$damaged"
    python3 - "$artifact/clickhouse.zip" "$damaged/clickhouse.zip" "$damage" <<'PY'
import sys, zipfile, xml.etree.ElementTree as ET
source, dest, kind = sys.argv[1:]
with zipfile.ZipFile(source) as original:
    files = {name: original.read(name) for name in original.namelist()}
manifest = ET.fromstring(files['.backup'])
part = next(name for name in files if name.startswith('data/') and name.endswith('/data.bin'))
metadata = next(name for name in files if name.startswith('metadata/') and name.endswith('.sql'))
if kind == 'missing-manifest': del files['.backup']
elif kind == 'malformed-manifest': files['.backup'] = b'<config><contents>'
elif kind == 'unsupported-version':
    manifest.find('version').text = '999'
    files['.backup'] = ET.tostring(manifest)
elif kind == 'missing-part': del files[part]
elif kind in ('tampered-part', 'tampered-metadata'):
    key = part if kind == 'tampered-part' else metadata
    data = files[key]
    assert data
    files[key] = bytes([data[0] ^ 1]) + data[1:]
elif kind == 'omitted-entry':
    contents = manifest.find('contents')
    entry = next(e for e in contents if e.findtext('name') == part)
    contents.remove(entry)
    files['.backup'] = ET.tostring(manifest)
with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as result:
    for name, data in files.items(): result.writestr(name, data)
PY
    (cd "$damaged" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
    for mode in validate restore; do
        args=(); [[ "$mode" == validate ]] && args=(--validate-only)
        if BACKUP_ARTIFACT="$damaged" "$root_dir/infra/scripts/restore.sh" "${args[@]}" >"$destination/${backup_id}-$damage-$mode.log" 2>&1; then
            printf 'ClickHouse %s accepted by %s\n' "$damage" "$mode" >&2; exit 1
        fi
        grep -q 'ClickHouse native backup validation failed' "$destination/${backup_id}-$damage-$mode.log" || { printf 'ClickHouse %s did not fail native preflight\n' "$damage" >&2; exit 1; }
        assert_targets_empty
    done
done
# The backup can be internally consistent while naming a different database.
wrong_db="$destination/${backup_id}-wrong-database"
cp -a "$artifact" "$wrong_db"
python3 - "$artifact/clickhouse.zip" "$wrong_db/clickhouse.zip" "$target_ch_database" <<'PY'
import sys, zipfile
src, dst, database = sys.argv[1:]
old = f'metadata/{database}.sql'
new = 'metadata/different_database.sql'
with zipfile.ZipFile(src) as original, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as result:
    for name in original.namelist():
        data = original.read(name)
        if name == '.backup': data = data.replace(old.encode(), new.encode())
        result.writestr(new if name == old else name, data)
PY
(cd "$wrong_db" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
BACKUP_ARTIFACT="$wrong_db" "$root_dir/infra/scripts/restore.sh" --validate-only >/dev/null
if BACKUP_ARTIFACT="$wrong_db" "$root_dir/infra/scripts/restore.sh" >"$destination/${backup_id}-wrong-database.log" 2>&1; then
    printf 'wrong ClickHouse database accepted\n' >&2; exit 1
fi
grep -q 'does not contain target database metadata' "$destination/${backup_id}-wrong-database.log" || { printf 'wrong database did not fail target preflight\n' >&2; exit 1; }
assert_targets_empty
# Intercept only the target version response; all target inspection and other
# operations still reach the real disposable stores.
version_bin="$(mktemp -d)"
real_docker="$(command -v docker)"
target_pg_id="$(docker inspect --format '{{.Id}}' "$("${target_compose[@]}" ps -q "$target_pg_service")")"
cat > "$version_bin/docker" <<'SH'
#!/usr/bin/env bash
if [[ "$MOCK_BAD_VERSION" == postgres && "$*" == *"exec -i -e PGPASSWORD $TARGET_PG_ID "* && "$*" == *"current_setting('server_version')"* ]]; then printf '17.4\n'; exit 0; fi
if [[ "$*" == *"--project-name $RESTORE_TARGET_COMPOSE_PROJECT "* ]]; then
    if [[ "$MOCK_BAD_VERSION" == clickhouse && "$*" == *'SELECT version()'* ]]; then printf '25.1\n'; exit 0; fi
fi
exec "$REAL_DOCKER" "$@"
SH
chmod 700 "$version_bin/docker"
for store in postgres clickhouse; do
    if PATH="$version_bin:$PATH" REAL_DOCKER="$real_docker" TARGET_PG_ID="$target_pg_id" MOCK_BAD_VERSION="$store" BACKUP_ARTIFACT="$artifact" "$root_dir/infra/scripts/restore.sh" >"$destination/${backup_id}-${store}-version.log" 2>&1; then
        printf 'mismatched target %s version accepted\n' "$store" >&2; exit 1
    fi
    grep -q 'target .*server_version does not match' "$destination/${backup_id}-${store}-version.log" || { printf 'target %s version did not fail preflight\n' "$store" >&2; cat "$destination/${backup_id}-${store}-version.log" >&2; exit 1; }
done
rm -rf -- "$version_bin"
# A checksum can be recomputed for malformed or malicious input; reject an
# invalid native archive in preflight, before issuing restore commands.
bad_artifact="$destination/${backup_id}-malformed"
cp -a "$artifact" "$bad_artifact"
printf 'not a PostgreSQL archive' > "$bad_artifact/postgres.dump"
(cd "$bad_artifact" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
if BACKUP_ARTIFACT="$bad_artifact" "$root_dir/infra/scripts/restore.sh" >"$destination/${backup_id}-malformed.log" 2>&1; then
    printf 'malformed PostgreSQL archive accepted\n' >&2; exit 1
fi
if ! grep -q 'PostgreSQL archive failed validation' "$destination/${backup_id}-malformed.log"; then
    printf 'malformed PostgreSQL archive was not rejected in preflight\n' >&2; exit 1
fi
[[ "$(PGPASSWORD="$target_pg_password" "${target_compose[@]}" exec -T -e PGPASSWORD "$target_pg_service" psql --no-password -At --username="$target_pg_user" --dbname="$target_pg_database" --command="SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" == 0 ]]
BACKUP_ARTIFACT="$artifact" "$root_dir/infra/scripts/restore.sh"
target_pg_probe="$(PGPASSWORD="$target_pg_password" "${target_compose[@]}" exec -T -e PGPASSWORD "$target_pg_service" psql --no-password --tuples-only --no-align --username="$target_pg_user" --dbname="$target_pg_database" --command="SELECT payload->>'value' FROM $probe WHERE probe_id = 'issue-43' AND organization_id = '43000000-0000-4000-8000-000000000001' AND project_id = '43000000-0000-4000-8000-000000000002'")"
target_ch_probe="$("${target_compose[@]}" exec -T "$target_ch_service" clickhouse-client --config-file "$target_ch_client_config" --database="$target_ch_database" --query="SELECT payload FROM $probe WHERE probe_id = 'issue-43' AND organization_id = '43000000-0000-4000-8000-000000000001' AND project_id = '43000000-0000-4000-8000-000000000002' AND metadata['fixture'] = 'upgrade' AND start_time = toDateTime64('2026-10-30 00:00:00.123', 3)")"
[[ "$target_pg_probe" == *representative-record* && "$target_ch_probe" == *representative-record* ]]
if PGPASSWORD="$target_pg_password" "${target_compose[@]}" exec -T -e PGPASSWORD "$target_pg_service" psql --no-password --set ON_ERROR_STOP=1 --username="$target_pg_user" --dbname="$target_pg_database" --command="INSERT INTO $probe (probe_id, payload) VALUES ('unscoped', '{}')" >/dev/null 2>&1; then
	printf 'restored PostgreSQL tenant constraint was not enforced\n' >&2
	exit 1
fi
if "${target_compose[@]}" exec -T "$target_ch_service" clickhouse-client --config-file "$target_ch_client_config" --database="$target_ch_database" --query="INSERT INTO $probe (probe_id, payload) VALUES ('unscoped', 'invalid')" >/dev/null 2>&1; then
	printf 'restored ClickHouse tenant constraint was not enforced\n' >&2
	exit 1
fi
if [[ "${BACKUP_RESTORE_APPLICATION_FIXTURE:-0}" == 1 ]]; then
	pg_service="$target_pg_service" ch_service="$target_ch_service" application_fixture verify "$target_pg_user" "$target_pg_password" "$target_pg_database" "$target_ch_user" "$target_ch_password" "$target_ch_database" "${target_compose[@]}"
fi
printf 'real PostgreSQL + ClickHouse backup/restore probe passed\n'
