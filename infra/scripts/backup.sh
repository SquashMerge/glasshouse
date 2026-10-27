#!/usr/bin/env bash
# Create one complete PostgreSQL + ClickHouse backup artifact.

set -euo pipefail
umask 077

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root_dir"
source "$(dirname "${BASH_SOURCE[0]}")/backup-restore-common.sh"

destination="${BACKUP_DESTINATION:-$root_dir/backups}"
source_id="${BACKUP_SOURCE_ID:-glasshouse-local}"
backup_id="${BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
source_compose_file="$(resolve_path "$root_dir" "${BACKUP_SOURCE_COMPOSE_FILE:-infra/compose.yaml}")"
source_env_file="$(resolve_path "$root_dir" "${BACKUP_SOURCE_ENV_FILE:-infra/.env}")"
source_project="${BACKUP_SOURCE_COMPOSE_PROJECT:-glasshouse}"
require_file 'BACKUP_SOURCE_COMPOSE_FILE' "$source_compose_file"
require_file 'BACKUP_SOURCE_ENV_FILE' "$source_env_file"
compose=(docker compose --project-directory "$root_dir" --env-file "$source_env_file" --project-name "$source_project" -f "$source_compose_file")
pg_service="${BACKUP_POSTGRES_SERVICE:-postgres}"
ch_service="${BACKUP_CLICKHOUSE_SERVICE:-clickhouse}"
pg_user="$(compose_service_value "$pg_service" POSTGRES_USER "${compose[@]}")"
pg_password="$(compose_service_value "$pg_service" POSTGRES_PASSWORD "${compose[@]}")"
pg_database="$(compose_service_value "$pg_service" POSTGRES_DB "${compose[@]}")"
ch_user="$(compose_service_value "$ch_service" CLICKHOUSE_USER "${compose[@]}")"
ch_database="$(compose_service_value "$ch_service" CLICKHOUSE_DB "${compose[@]}")"
ch_password="$(compose_service_value "$ch_service" CLICKHOUSE_PASSWORD "${compose[@]}")"

if [[ ! "$backup_id" =~ ^[A-Za-z0-9._-]+$ || ! "$pg_database" =~ ^[A-Za-z0-9_]+$ || ! "$ch_database" =~ ^[A-Za-z0-9_]+$ ]]; then
	printf 'Backup ID and database names must use only safe ASCII identifier characters.\n' >&2
	exit 1
fi
ch_remote="/var/lib/clickhouse/backup/glasshouse-${backup_id}-$$.zip"
ch_client_config=""

if [[ "$destination" != /* ]]; then
	destination="$root_dir/$destination"
fi
mkdir -p "$destination"
chmod 700 "$destination"

staging="$destination/.${backup_id}.staging.$$"
final="$destination/$backup_id"
mkdir "$staging"
chmod 700 "$staging"
cleanup() {
	if [[ -n "$ch_client_config" ]]; then
		remove_clickhouse_client_config "$ch_service" "$ch_client_config" "${compose[@]}"
	fi
	"${compose[@]}" exec -T "$ch_service" sh -ec 'rm -f -- "$1"' sh "$ch_remote" >/dev/null 2>&1 || true
	rm -rf -- "$staging"
}
trap cleanup EXIT
ch_client_config="$(create_clickhouse_client_config "$ch_service" "$ch_user" "$ch_password" "${compose[@]}")"

printf 'Creating PostgreSQL backup...\n'
PGPASSWORD="$pg_password" "${compose[@]}" exec -T -e PGPASSWORD "$pg_service" pg_dump --no-password --format=custom --no-owner --no-privileges --username="$pg_user" "$pg_database" > "$staging/postgres.dump"
chmod 600 "$staging/postgres.dump"

printf 'Creating ClickHouse backup...\n'
"${compose[@]}" exec -T "$ch_service" sh -ec 'mkdir -p /var/lib/clickhouse/backup && rm -f -- "$1"' sh "$ch_remote"
"${compose[@]}" exec -T "$ch_service" clickhouse-client --config-file "$ch_client_config" --database "$ch_database" --query "BACKUP DATABASE \`$ch_database\` TO File('$ch_remote')"
"${compose[@]}" cp "$ch_service:$ch_remote" "$staging/clickhouse.zip"
"${compose[@]}" exec -T "$ch_service" sh -ec 'rm -f -- "$1"' sh "$ch_remote"
chmod 600 "$staging/clickhouse.zip"

pg_version="$(PGPASSWORD="$pg_password" "${compose[@]}" exec -T -e PGPASSWORD "$pg_service" psql --no-password --tuples-only --no-align --username="$pg_user" --dbname="$pg_database" --command="SELECT current_setting('server_version')" | tr -d '\r' | tr -d '[:space:]')"
ch_version="$("${compose[@]}" exec -T "$ch_service" clickhouse-client --config-file "$ch_client_config" --query='SELECT version()' | tr -d '\r' | tr -d '[:space:]')"

(cd "$staging" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
chmod 600 "$staging/SHA256SUMS"
BACKUP_ID="$backup_id" SOURCE_ID="$source_id" PG_VERSION="$pg_version" CH_VERSION="$ch_version" python3 - "$staging/manifest.json" <<'PY'
import json
import os
import pathlib
import time

path = pathlib.Path(os.sys.argv[1])
path.write_text(json.dumps({
    "format": "glasshouse-backup-v1",
    "backup_id": os.environ["BACKUP_ID"],
    "source_id": os.environ["SOURCE_ID"],
    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "postgres_server_version": os.environ["PG_VERSION"],
    "clickhouse_server_version": os.environ["CH_VERSION"],
    "stores": ["postgresql", "clickhouse"],
    "files": ["postgres.dump", "clickhouse.zip", "SHA256SUMS"],
    "complete": True,
}, sort_keys=True, indent=2) + "\n")
PY
chmod 600 "$staging/manifest.json"

python3 - "$staging" <<'PY'
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
    raise SystemExit("backup manifest is not complete")
if not isinstance(manifest.get("source_id"), str) or not manifest["source_id"].strip():
    raise SystemExit("backup source identity is missing")
for name in ("postgres.dump", "clickhouse.zip", "SHA256SUMS"):
    if not (root / name).is_file() or (root / name).stat().st_size == 0:
        raise SystemExit(f"backup file is missing or empty: {name}")
archive = root / "clickhouse.zip"
if not zipfile.is_zipfile(archive):
    raise SystemExit("clickhouse.zip is not a valid ZIP archive")
with zipfile.ZipFile(archive) as clickhouse_archive:
    if clickhouse_archive.testzip() is not None:
        raise SystemExit("clickhouse.zip contains corrupt data")
for line in (root / "SHA256SUMS").read_text().splitlines():
    digest, name = line.split("  ", 1)
    if name not in {"postgres.dump", "clickhouse.zip"}:
        raise SystemExit(f"unexpected checksum entry: {name}")
    actual = sha256_file(root / name)
    if digest != actual:
        raise SystemExit(f"checksum mismatch: {name}")
PY

if [[ -e "$final" ]]; then
	printf 'Refusing to replace existing backup artifact: %s\n' "$final" >&2
	exit 1
fi
mv -- "$staging" "$final"
cleanup
trap - EXIT
printf 'Backup complete: %s\n' "$final"
