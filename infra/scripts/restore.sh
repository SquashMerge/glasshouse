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
manifest = json.loads((root / "manifest.json").read_text())
if manifest.get("format") != "glasshouse-backup-v1" or manifest.get("complete") is not True:
    raise SystemExit("backup is incomplete or unsupported")
if not isinstance(manifest.get("source_id"), str) or not manifest["source_id"].strip():
    raise SystemExit("backup source identity is missing")
if manifest.get("stores") != ["postgresql", "clickhouse"]:
    raise SystemExit("backup does not cover both stores")
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
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
        raise SystemExit(f"checksum mismatch: {name}")
PY

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
if [[ "${RESTORE_TARGET_LIVE:-false}" != "false" ]]; then
	printf 'Refusing restore to a live installation; set RESTORE_TARGET_LIVE=false.\n' >&2
	exit 1
fi
if [[ "$confirmation" != "RESTORE GLASSHOUSE TO $target_id" ]]; then
	printf 'Refusing restore: exact RESTORE_CONFIRMATION is required.\n' >&2
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
require_file 'BACKUP_SOURCE_COMPOSE_FILE' "$source_compose_file"
require_file 'BACKUP_SOURCE_ENV_FILE' "$source_env_file"
if [[ "$target_dir" == "$root_dir" || "$target_compose_file" == "$root_dir/infra/compose.yaml" ]]; then
	printf 'Refusing restore into the source checkout or Compose file.\n' >&2
	exit 1
fi

target_compose=(docker compose --project-directory "$target_dir" --env-file "$target_env_file" --project-name "$target_project" -f "$target_compose_file")
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
source_mounts="$(docker inspect --format='{{range .Mounts}}{{.Name}}|{{.Source}} {{end}}' "$source_pg" "$source_ch")"
target_mounts="$(docker inspect --format='{{range .Mounts}}{{.Name}}|{{.Source}} {{end}}' "$target_pg" "$target_ch")"
for mount in $source_mounts; do
	if [[ "$mount" != '|' && " $target_mounts " == *" $mount "* ]]; then
		printf 'Refusing restore: target shares source volume %s.\n' "$mount" >&2
		exit 1
	fi
done

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
pg_tables="$("${target_compose[@]}" exec -T "$pg_service" env "PGPASSWORD=$pg_password" psql --no-password --tuples-only --no-align --username="$pg_user" --dbname="$pg_database" --command="SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p') AND relname NOT IN ('pgmigrations');" | tr -d '[:space:]')"
ch_tables="$("${target_compose[@]}" exec -T "$ch_service" clickhouse-client --user "$ch_user" --password "$ch_password" --database "$ch_database" --query="SELECT count() FROM system.tables WHERE database = '$ch_database' AND name != 'glasshouse_schema_migrations'" | tr -d '[:space:]')"
if [[ "$pg_tables" != "0" || "$ch_tables" != "0" ]]; then
	printf 'Refusing restore: target data stores are not empty.\n' >&2
	exit 1
fi

printf 'Restoring PostgreSQL...\n'
cat "$artifact/postgres.dump" | "${target_compose[@]}" exec -T -i "$pg_service" env "PGPASSWORD=$pg_password" pg_restore --no-owner --no-privileges --username="$pg_user" --dbname="$pg_database"
ch_remote="/var/lib/clickhouse/backup/restore-${target_id}-$$.zip"
"${target_compose[@]}" cp "$artifact/clickhouse.zip" "$ch_service:$ch_remote"
printf 'Restoring ClickHouse...\n'
"${target_compose[@]}" exec -T "$ch_service" clickhouse-client --user "$ch_user" --password "$ch_password" --database "$ch_database" --query="RESTORE DATABASE \`$ch_database\` FROM File('$ch_remote')"
"${target_compose[@]}" exec -T "$ch_service" sh -ec 'rm -f -- "$1"' sh "$ch_remote"
printf 'Restore complete. Run the target migrations and health smoke checks before serving traffic.\n'
