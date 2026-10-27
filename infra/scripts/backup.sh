#!/usr/bin/env bash
# Create one complete PostgreSQL + ClickHouse backup artifact.

set -euo pipefail
umask 077

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root_dir"

destination="${BACKUP_DESTINATION:-$root_dir/backups}"
source_id="${BACKUP_SOURCE_ID:-glasshouse-local}"
backup_id="${BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
compose=(docker compose --project-directory "$root_dir" --env-file "$root_dir/infra/.env" -f "$root_dir/infra/compose.yaml")
pg_service="${BACKUP_POSTGRES_SERVICE:-postgres}"
ch_service="${BACKUP_CLICKHOUSE_SERVICE:-clickhouse}"
pg_user="${POSTGRES_USER:-glasshouse}"
pg_database="${POSTGRES_DB:-glasshouse}"
ch_user="${CLICKHOUSE_USER:-glasshouse}"
ch_database="${CLICKHOUSE_DB:-glasshouse}"

if [[ ! "$backup_id" =~ ^[A-Za-z0-9._-]+$ || ! "$pg_database" =~ ^[A-Za-z0-9_]+$ || ! "$ch_database" =~ ^[A-Za-z0-9_]+$ ]]; then
	printf 'Backup ID and database names must use only safe ASCII identifier characters.\n' >&2
	exit 1
fi

if [[ ! -f "$root_dir/infra/.env" ]]; then
	printf 'infra/.env is required; credentials are read by Compose, not printed.\n' >&2
	exit 1
fi
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
	rm -rf -- "$staging"
}
trap cleanup EXIT

printf 'Creating PostgreSQL backup...\n'
"${compose[@]}" exec -T "$pg_service" pg_dump --format=custom --no-owner --no-privileges --username="$pg_user" "$pg_database" > "$staging/postgres.dump"
chmod 600 "$staging/postgres.dump"

ch_remote="/var/lib/clickhouse/backup/glasshouse-${backup_id}-$$.zip"
printf 'Creating ClickHouse backup...\n'
"${compose[@]}" exec -T "$ch_service" sh -ec 'mkdir -p /var/lib/clickhouse/backup && rm -f -- "$1"' sh "$ch_remote"
"${compose[@]}" exec -T "$ch_service" clickhouse-client --user "$ch_user" --password "${CLICKHOUSE_PASSWORD:-}" --database "$ch_database" --query "BACKUP DATABASE \`$ch_database\` TO File('$ch_remote')"
"${compose[@]}" cp "$ch_service:$ch_remote" "$staging/clickhouse.zip"
"${compose[@]}" exec -T "$ch_service" sh -ec 'rm -f -- "$1"' sh "$ch_remote"
chmod 600 "$staging/clickhouse.zip"

pg_version="$("${compose[@]}" exec -T "$pg_service" psql --no-password --tuples-only --no-align --username="$pg_user" --dbname="$pg_database" --command="SELECT current_setting('server_version')" | tr -d '\r' | tr -d '[:space:]')"
ch_version="$("${compose[@]}" exec -T "$ch_service" clickhouse-client --user "$ch_user" --password "${CLICKHOUSE_PASSWORD:-}" --query='SELECT version()' | tr -d '\r' | tr -d '[:space:]')"

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

root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_text())
if manifest.get("format") != "glasshouse-backup-v1" or manifest.get("complete") is not True:
    raise SystemExit("backup manifest is not complete")
if not isinstance(manifest.get("source_id"), str) or not manifest["source_id"].strip():
    raise SystemExit("backup source identity is missing")
for name in ("postgres.dump", "clickhouse.zip", "SHA256SUMS"):
    if not (root / name).is_file() or (root / name).stat().st_size == 0:
        raise SystemExit(f"backup file is missing or empty: {name}")
for line in (root / "SHA256SUMS").read_text().splitlines():
    digest, name = line.split("  ", 1)
    if name not in {"postgres.dump", "clickhouse.zip"}:
        raise SystemExit(f"unexpected checksum entry: {name}")
    actual = hashlib.sha256((root / name).read_bytes()).hexdigest()
    if digest != actual:
        raise SystemExit(f"checksum mismatch: {name}")
PY

if [[ -e "$final" ]]; then
	printf 'Refusing to replace existing backup artifact: %s\n' "$final" >&2
	exit 1
fi
mv -- "$staging" "$final"
trap - EXIT
printf 'Backup complete: %s\n' "$final"
