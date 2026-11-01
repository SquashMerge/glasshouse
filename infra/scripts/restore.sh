#!/usr/bin/env bash
# Restore a validated artifact into a separate, empty Compose deployment.

set -euo pipefail
umask 077

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/backup-restore-common.sh"
validate_only=false
if [[ "${1:-}" == "--validate-only" ]]; then
	validate_only=true
	shift
fi
artifact="${BACKUP_ARTIFACT:-${1:-}}"
if [[ -z "$artifact" || ! -d "$artifact" ]]; then
	printf 'BACKUP_ARTIFACT must name a backup directory.\n' >&2
	exit 1
fi

# Open each operator-owned file without following symlinks and copy it into a
# private directory. All subsequent checks and restores use the same copy.
private_stage="$(mktemp -d)"
trap 'rm -rf -- "$private_stage"' EXIT
python3 - "$artifact" "$private_stage" <<'PY'
import os
import shutil
import stat
import sys

source, destination = sys.argv[1:]
# A trailing slash otherwise causes the kernel to follow the final symlink
# despite O_NOFOLLOW on the directory open.
source = source.rstrip('/') or '/'
fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise SystemExit("artifact directory must be operator-owned and private")
    for name in ("manifest.json", "SHA256SUMS", "postgres.dump", "clickhouse.zip"):
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(file_fd, 'rb') as src:
            info = os.fstat(src.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_nlink != 1:
                raise SystemExit(f"artifact file must be private, operator-owned, regular and unlinked: {name}")
            with open(os.path.join(destination, name), 'xb') as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
finally:
    os.close(fd)
PY
artifact="$private_stage"
manifest="$artifact/manifest.json"
if [[ ! -f "$manifest" ]]; then
	printf 'Refusing artifact without a completion manifest.\n' >&2
	exit 1
fi
python3 - "$artifact" <<'PY'
import hashlib
import json
import pathlib
import sys
import zipfile

root = pathlib.Path(sys.argv[1])

def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

manifest = json.loads((root / "manifest.json").read_text())
if manifest.get("format") != "glasshouse-backup-v1" or manifest.get("complete") is not True:
    raise SystemExit("backup is incomplete or unsupported")
if not isinstance(manifest.get("source_id"), str) or not manifest["source_id"].strip():
    raise SystemExit("backup source identity is missing")
if manifest.get("stores") != ["postgresql", "clickhouse"]:
    raise SystemExit("backup does not cover both stores")
for key, supported in (("postgres_server_version", "18.6"), ("clickhouse_server_version", "26.10.2.103")):
    if manifest.get(key) != supported:
        raise SystemExit(f"unsupported or missing {key}: current version required")
for name in ("postgres.dump", "clickhouse.zip", "SHA256SUMS"):
    if not (root / name).is_file() or (root / name).stat().st_size == 0:
        raise SystemExit(f"backup file is missing or empty: {name}")
archive = root / "clickhouse.zip"
if not zipfile.is_zipfile(archive):
    raise SystemExit("clickhouse.zip is not a valid ZIP archive")
with zipfile.ZipFile(archive) as clickhouse_archive:
    if clickhouse_archive.testzip() is not None:
        raise SystemExit("clickhouse.zip contains corrupt data")
expected = {"postgres.dump", "clickhouse.zip"}
checksums = {}
for line in (root / "SHA256SUMS").read_text().splitlines():
    try:
        digest, name = line.split("  ", 1)
    except ValueError:
        raise SystemExit("malformed SHA256SUMS entry")
    if name not in expected or name in checksums:
        raise SystemExit(f"unexpected or duplicate checksum entry: {name}")
    if len(digest) != 64 or any(char not in "0123456789abcdefABCDEF" for char in digest):
        raise SystemExit(f"malformed checksum for: {name}")
    checksums[name] = digest.lower()
if set(checksums) != expected:
    raise SystemExit("SHA256SUMS must contain exactly one checksum for each backup file")
for name, digest in checksums.items():
    if sha256_file(root / name) != digest:
        raise SystemExit(f"checksum mismatch: {name}")
PY

# Validate native backup metadata and each referenced data file, not only ZIP
# CRCs and the operator-supplied outer checksum. Runs on the private copy.
python3 "$root_dir/infra/scripts/check-clickhouse-backup.py" "$artifact/clickhouse.zip"

if [[ "$validate_only" == true ]]; then
	printf 'Backup artifact is valid.\n'
	exit 0
fi

source_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_id"])' "$manifest")"
target_id="${RESTORE_TARGET_ID:-}"
confirmation="${RESTORE_CONFIRMATION:-}"
if [[ -z "$target_id" || "$target_id" == "$source_id" || ! "$target_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
	printf 'Refusing restore: RESTORE_TARGET_ID must be explicit and differ from source identity.\n' >&2
	exit 1
fi
if [[ "${RESTORE_TARGET_LIVE:-}" != "false" ]]; then
	printf 'Refusing restore to a live installation; set RESTORE_TARGET_LIVE=false.\n' >&2
	exit 1
fi
if [[ "$confirmation" != "RESTORE GLASSHOUSE TO $target_id" ]]; then
	printf 'Refusing restore: exact RESTORE_CONFIRMATION is required.\n' >&2
	exit 1
fi

if [[ "${RESTORE_TRUSTED_ARTIFACT:-}" != 'I TRUST THIS BACKUP' ]]; then
	printf 'Refusing restore: verify provenance and set RESTORE_TRUSTED_ARTIFACT="I TRUST THIS BACKUP". Checksums do not establish trust.\n' >&2
	exit 1
fi

target_dir="${RESTORE_TARGET_DIRECTORY:-}"
target_compose_file="${RESTORE_TARGET_COMPOSE_FILE:-}"
target_project="${RESTORE_TARGET_COMPOSE_PROJECT:-}"
if [[ -z "$target_dir" || -z "$target_compose_file" || -z "$target_project" ]]; then
	printf 'RESTORE_TARGET_DIRECTORY, RESTORE_TARGET_COMPOSE_FILE, and RESTORE_TARGET_COMPOSE_PROJECT are required.\n' >&2
	exit 1
fi
target_dir="$(cd "$target_dir" && pwd)"
target_compose_file="$(resolve_path "$target_dir" "$target_compose_file")"
target_compose_file="$(cd "$(dirname "$target_compose_file")" && pwd)/$(basename "$target_compose_file")"
target_env_file="${RESTORE_TARGET_ENV_FILE:-$target_dir/infra/.env}"
target_env_file="$(resolve_path "$target_dir" "$target_env_file")"
source_compose_file="$(resolve_path "$root_dir" "${BACKUP_SOURCE_COMPOSE_FILE:-infra/compose.yaml}")"
source_env_file="$(resolve_path "$root_dir" "${BACKUP_SOURCE_ENV_FILE:-infra/.env}")"
source_project="${BACKUP_SOURCE_COMPOSE_PROJECT:-glasshouse}"
require_file 'RESTORE_TARGET_COMPOSE_FILE' "$target_compose_file"
require_file 'RESTORE_TARGET_ENV_FILE' "$target_env_file"
if [[ "${RESTORE_SOURCE_UNAVAILABLE:-false}" != true ]]; then
	require_file 'BACKUP_SOURCE_COMPOSE_FILE' "$source_compose_file"
	require_file 'BACKUP_SOURCE_ENV_FILE' "$source_env_file"
fi
if [[ "$target_dir" == "$root_dir" || "$target_compose_file" == "$root_dir/infra/compose.yaml" ]]; then
	printf 'Refusing restore into the source checkout or Compose file.\n' >&2
	exit 1
fi

target_compose=(docker compose --project-directory "$target_dir" --env-file "$target_env_file" --project-name "$target_project" -f "$target_compose_file")
if [[ "${RESTORE_SOURCE_UNAVAILABLE:-false}" == true ]]; then
	if [[ "${RESTORE_SOURCE_UNAVAILABLE_CONFIRMATION:-}" != 'SOURCE IS UNAVAILABLE' || "${RESTORE_DISTINCT_HOST_CONFIRMATION:-}" != 'I VERIFIED DISTINCT HOST' || "${RESTORE_DISTINCT_STORAGE_CONFIRMATION:-}" != 'I VERIFIED DISTINCT STORAGE' ]]; then
		printf 'Refusing restore: source unavailability and independently verified distinct host and storage confirmations are required.\n' >&2
		exit 1
	fi
	mapfile -t source_metadata < <(python3 - "$manifest" <<'PY'
import json, re, sys
with open(sys.argv[1]) as stream:
    data = json.load(stream)
values = [data.get('source_docker_daemon_id'), data.get('source_compose_project')]
if all(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:-]+', value) for value in values):
    print(*values, sep='\n')
PY
)
	if [[ "${#source_metadata[@]}" != 2 ]]; then
		printf 'Refusing restore: source Docker daemon and Compose project metadata are required.\n' >&2
		exit 1
	fi
	target_daemon_id="$(docker info --format '{{.ID}}')"
	if [[ -z "$target_daemon_id" || "$target_daemon_id" == '<no value>' || "$target_daemon_id" == "${source_metadata[0]}" ]]; then
		printf 'Refusing restore: source and target Docker daemon IDs must differ.\n' >&2
		exit 1
	fi
	if [[ "$target_project" == "${source_metadata[1]}" ]]; then
		printf 'Refusing restore: source and target Compose projects must differ.\n' >&2
		exit 1
	fi
	target_pg="$("${target_compose[@]}" ps -q "${RESTORE_POSTGRES_SERVICE:-postgres}")"
	target_ch="$("${target_compose[@]}" ps -q "${RESTORE_CLICKHOUSE_SERVICE:-clickhouse}")"
	if [[ -z "$target_pg" || -z "$target_ch" ]]; then
		printf 'Refusing restore: target services must already be running.\n' >&2
		exit 1
	fi
else
	source_compose=(docker compose --project-directory "$root_dir" --env-file "$source_env_file" --project-name "$source_project" -f "$source_compose_file")
	target_pg="$("${target_compose[@]}" ps -q "${RESTORE_POSTGRES_SERVICE:-postgres}")"
	target_ch="$("${target_compose[@]}" ps -q "${RESTORE_CLICKHOUSE_SERVICE:-clickhouse}")"
	source_pg="$("${source_compose[@]}" ps -q "${BACKUP_POSTGRES_SERVICE:-postgres}")"
	source_ch="$("${source_compose[@]}" ps -q "${BACKUP_CLICKHOUSE_SERVICE:-clickhouse}")"
	if [[ -z "$target_pg" || -z "$target_ch" || -z "$source_pg" || -z "$source_ch" ]]; then
		printf 'Refusing restore: source and target services must already be running.\n' >&2
		exit 1
	fi
	if [[ "$target_pg" == "$source_pg" || "$target_ch" == "$source_ch" ]]; then
		printf 'Refusing restore: target shares a source container.\n' >&2
		exit 1
	fi
	source_container_project="$(inspect_compose_project "$source_pg")"
	if [[ "$target_project" == "$source_container_project" || "$target_project" == "$source_project" ]]; then
		printf 'Refusing restore: target Compose project is the live/source project.\n' >&2
		exit 1
	fi
	if ! docker inspect "$source_pg" "$source_ch" "$target_pg" "$target_ch" | python3 "$root_dir/infra/scripts/check-restore-mounts.py"; then
		printf 'Refusing restore: source and target storage mounts overlap or could not be inspected.\n' >&2
		exit 1
	fi
fi

# Apply the same dedicated local-volume contract in both source modes.
target_pg="$(docker inspect --format '{{.Id}}' "$target_pg")"
target_ch="$(docker inspect --format '{{.Id}}' "$target_ch")"
"${target_compose[@]}" config --format json > "$private_stage/target-compose.json"
python3 "$root_dir/infra/scripts/check-isolated-target.py" \
    "$target_project" "$target_pg" "$target_ch" \
    "${RESTORE_POSTGRES_SERVICE:-postgres}" "${RESTORE_CLICKHOUSE_SERVICE:-clickhouse}" \
    "$private_stage/target-compose.json"

pg_service="${RESTORE_POSTGRES_SERVICE:-postgres}"
ch_service="${RESTORE_CLICKHOUSE_SERVICE:-clickhouse}"
pg_user="$(compose_service_value "$pg_service" POSTGRES_USER "${target_compose[@]}")"
pg_password="$(compose_service_value "$pg_service" POSTGRES_PASSWORD "${target_compose[@]}")"
pg_database="$(compose_service_value "$pg_service" POSTGRES_DB "${target_compose[@]}")"
ch_user="$(compose_service_value "$ch_service" CLICKHOUSE_USER "${target_compose[@]}")"
ch_password="$(compose_service_value "$ch_service" CLICKHOUSE_PASSWORD "${target_compose[@]}")"
ch_database="$(compose_service_value "$ch_service" CLICKHOUSE_DB "${target_compose[@]}")"
if [[ ! "$pg_database" =~ ^[A-Za-z0-9_]+$ || ! "$ch_database" =~ ^[A-Za-z0-9_]+$ ]]; then
	printf 'Restore database names must use only safe ASCII identifier characters.\n' >&2
	exit 1
fi
# A valid backup of some *other* database cannot satisfy this RESTORE DATABASE.
python3 - "$artifact/clickhouse.zip" "$ch_database" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    expected = 'metadata/' + sys.argv[2] + '.sql'
    if expected not in archive.namelist():
        raise SystemExit('Refusing restore: ClickHouse backup does not contain target database metadata.')
PY
ch_remote="/var/lib/clickhouse/backup/restore-${target_id}-$$.zip"
ch_client_config=""
ch_remote_created=false
restore_cleanup() {
	if [[ -n "$ch_client_config" ]]; then
		remove_clickhouse_client_config "$ch_service" "$ch_client_config" "${target_compose[@]}"
	fi
	if [[ "$ch_remote_created" == true ]]; then
		"${target_compose[@]}" exec -T "$ch_service" sh -ec 'rm -f -- "$1"' sh "$ch_remote" >/dev/null 2>&1 || true
	fi
	rm -rf -- "$private_stage"
}
trap restore_cleanup EXIT
# A clean libpq environment and fixed Unix socket/port bind every PostgreSQL
# query and restore to the inspected container, not inherited service settings.
pg_client() {
    PGPASSWORD="$pg_password" docker exec -i -e PGPASSWORD "$target_pg" sh -ec \
        'exec env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PGPASSWORD="$PGPASSWORD" "$@"' sh "$@"
}
pg_psql() {
    pg_client psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 \
        --host=/var/run/postgresql --port=5432 --username="$pg_user" --dbname="$pg_database" "$@"
}
ch_client_config="$(create_clickhouse_client_config "$ch_service" "$ch_user" "$ch_password" "${target_compose[@]}")"
pg_target_version="$(pg_psql --tuples-only --no-align --command="SELECT current_setting('server_version')" | tr -d '[:space:]')"
pg_data="$(pg_psql --tuples-only --no-align --command="SHOW data_directory")"
if ! python3 "$root_dir/infra/scripts/check-isolated-target.py" --runtime-paths "$target_pg" /var/lib/postgresql "$pg_data" "$pg_data/pg_wal"; then
    printf 'Refusing restore: PostgreSQL data directory or WAL is outside the dedicated volume.\n' >&2
    exit 1
fi
pg_tablespaces="$(pg_psql --tuples-only --no-align --command="SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default', 'pg_global')")"
if [[ "$pg_tablespaces" != 0 ]]; then
    printf 'Refusing restore: PostgreSQL custom tablespaces are unsupported.\n' >&2
    exit 1
fi
ch_target_version="$("${target_compose[@]}" exec -T "$ch_service" clickhouse-client --host=127.0.0.1 --port=9000 --config-file "$ch_client_config" --query='SELECT version()' | tr -d '[:space:]')"
"${target_compose[@]}" exec -T "$ch_service" clickhouse-client --host=127.0.0.1 --port=9000 --config-file "$ch_client_config" --query="SELECT value FROM system.server_settings WHERE name='path' FORMAT TSVRaw" > "$private_stage/ch-path"
"${target_compose[@]}" exec -T "$ch_service" clickhouse-client --host=127.0.0.1 --port=9000 --config-file "$ch_client_config" --query='SELECT name, path, type FROM system.disks FORMAT JSONEachRow' > "$private_stage/ch-disks"
python3 - "$private_stage" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
data = {'path': (p / 'ch-path').read_text().strip(),
        'disks': [json.loads(line) for line in (p / 'ch-disks').read_text().splitlines()]}
(p / 'ch-storage.json').write_text(json.dumps(data))
PY
if ! python3 "$root_dir/infra/scripts/check-isolated-target.py" --clickhouse-paths "$target_ch" /var/lib/clickhouse/backup "$private_stage/ch-storage.json"; then
    printf 'Refusing restore: ClickHouse data paths or disks are outside the dedicated volume.\n' >&2
    exit 1
fi
python3 - "$manifest" "$pg_target_version" "$ch_target_version" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    manifest = json.load(stream)
for key, actual in zip(("postgres_server_version", "clickhouse_server_version"), sys.argv[2:]):
    if not actual or manifest[key] != actual:
        raise SystemExit(f"Refusing restore: target {key} does not match supported backup version")
PY
# --list reads only the table of contents; render the whole custom dump to a
# discarded stream so compressed data is read without executing SQL or logging it.
if ! pg_client pg_restore --exit-on-error --file=- < "$artifact/postgres.dump" >/dev/null 2>/dev/null; then
    printf 'Refusing restore: PostgreSQL archive failed validation.\n' >&2
    exit 1
fi
pg_empty_query="$(cat <<'SQL'
SELECT
  (SELECT count(*) FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog','information_schema','public')
     AND nspname NOT LIKE 'pg_toast%'
     AND nspname NOT LIKE 'pg_temp%')
  + (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog','information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND n.nspname NOT LIKE 'pg_temp%'
       AND c.relkind IN ('r','p','v','m','S','f','c'))
  + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public')
  + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public')
  + (SELECT count(*) FROM pg_largeobject_metadata);
SQL
)"
pg_tables="$(pg_psql --tuples-only --no-align --command="$pg_empty_query" | tr -d '[:space:]')"
ch_tables="$("${target_compose[@]}" exec -T "$ch_service" clickhouse-client --host=127.0.0.1 --port=9000 --config-file "$ch_client_config" --database "$ch_database" --query="SELECT count() FROM system.tables WHERE database = '$ch_database'" | tr -d '[:space:]')"
if [[ "$pg_tables" != "0" || "$ch_tables" != "0" ]]; then
	printf 'Refusing restore: target data stores are not empty.\n' >&2
	exit 1
fi

printf 'Restoring PostgreSQL...\n'
pg_client pg_restore --exit-on-error --single-transaction --no-password --no-owner --no-privileges --no-tablespaces --host=/var/run/postgresql --port=5432 --username="$pg_user" --dbname="$pg_database" < "$artifact/postgres.dump"
ch_remote_created=true
"${target_compose[@]}" cp "$artifact/clickhouse.zip" "$ch_service:$ch_remote"
"${target_compose[@]}" exec -T --user root "$ch_service" sh -ec 'chown clickhouse:clickhouse "$1" && chmod 600 "$1"' sh "$ch_remote"
printf 'Restoring ClickHouse...\n'
"${target_compose[@]}" exec -T "$ch_service" clickhouse-client --host=127.0.0.1 --port=9000 --config-file "$ch_client_config" --database "$ch_database" --query="RESTORE DATABASE \`$ch_database\` FROM File('$ch_remote')"
"${target_compose[@]}" exec -T "$ch_service" sh -ec 'rm -f -- "$1"' sh "$ch_remote"
ch_remote_created=false
printf 'Restore complete. Run the target migrations and health smoke checks before serving traffic.\n'
