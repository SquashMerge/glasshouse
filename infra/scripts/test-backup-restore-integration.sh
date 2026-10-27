#!/usr/bin/env bash
# Real operator/CI gate. It needs a running source stack and a separately
# provisioned, empty target stack with unique volumes.

set -euo pipefail
umask 077
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
destination="${BACKUP_RESTORE_DESTINATION:-$(mktemp -d)}"
backup_id="backup-restore-integration-$$"
probe="backup_restore_probe_$$"
source_compose=(docker compose --project-directory "$root_dir" --env-file "$root_dir/infra/.env" -f "$root_dir/infra/compose.yaml")
pg_user="${POSTGRES_USER:-glasshouse}"
pg_database="${POSTGRES_DB:-glasshouse}"
ch_user="${CLICKHOUSE_USER:-glasshouse}"
ch_database="${CLICKHOUSE_DB:-glasshouse}"

cleanup() {
	"${source_compose[@]}" exec -T postgres psql --no-password --username="$pg_user" --dbname="$pg_database" --command="DROP TABLE IF EXISTS \"$probe\"" >/dev/null 2>&1 || true
	"${source_compose[@]}" exec -T clickhouse clickhouse-client --user "$ch_user" --password "${CLICKHOUSE_PASSWORD:-}" --database "$ch_database" --query="DROP TABLE IF EXISTS \`$probe\`" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${source_compose[@]}" exec -T postgres psql --no-password --username="$pg_user" --dbname="$pg_database" --command="CREATE TABLE \"$probe\" (probe_id text PRIMARY KEY, payload text NOT NULL); INSERT INTO \"$probe\" VALUES ('issue-7', 'representative-record');" >/dev/null
"${source_compose[@]}" exec -T clickhouse clickhouse-client --user "$ch_user" --password "${CLICKHOUSE_PASSWORD:-}" --database "$ch_database" --query="CREATE TABLE \`$probe\` (probe_id String, payload String) ENGINE = MergeTree ORDER BY probe_id; INSERT INTO \`$probe\` VALUES ('issue-7', 'representative-record')" >/dev/null

BACKUP_DESTINATION="$destination" BACKUP_SOURCE_ID=integration BACKUP_ID="$backup_id" "$root_dir/infra/scripts/backup.sh"
artifact="$destination/$backup_id"
BACKUP_ARTIFACT="$artifact" "$root_dir/infra/scripts/restore.sh" --validate-only
BACKUP_ARTIFACT="$artifact" "$root_dir/infra/scripts/restore.sh"

target_compose=(docker compose --project-directory "$RESTORE_TARGET_DIRECTORY" --env-file "$RESTORE_TARGET_DIRECTORY/infra/.env" --project-name "$RESTORE_TARGET_COMPOSE_PROJECT" -f "$RESTORE_TARGET_COMPOSE_FILE")
target_pg_probe="$("${target_compose[@]}" exec -T "${RESTORE_POSTGRES_SERVICE:-postgres}" psql --no-password --tuples-only --no-align --username="${RESTORE_POSTGRES_USER:-glasshouse}" --dbname="${RESTORE_POSTGRES_DB:-glasshouse}" --command="SELECT payload FROM \"$probe\" WHERE probe_id = 'issue-7'")"
target_ch_probe="$("${target_compose[@]}" exec -T "${RESTORE_CLICKHOUSE_SERVICE:-clickhouse}" clickhouse-client --user "${RESTORE_CLICKHOUSE_USER:-glasshouse}" --password "${RESTORE_CLICKHOUSE_PASSWORD:-}" --database="${RESTORE_CLICKHOUSE_DB:-glasshouse}" --query="SELECT payload FROM \`$probe\` WHERE probe_id = 'issue-7'")"
[[ "$target_pg_probe" == *representative-record* && "$target_ch_probe" == *representative-record* ]]
printf 'real PostgreSQL + ClickHouse backup/restore probe passed\n'
