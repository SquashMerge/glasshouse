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

cleanup() {
	"${source_compose[@]}" exec -T "$pg_service" env "PGPASSWORD=$pg_password" psql --no-password --username="$pg_user" --dbname="$pg_database" --command="DROP TABLE IF EXISTS \"$probe\"" >/dev/null 2>&1 || true
	"${source_compose[@]}" exec -T "$ch_service" clickhouse-client --user "$ch_user" --password "$ch_password" --database "$ch_database" --query="DROP TABLE IF EXISTS \`$probe\`" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${source_compose[@]}" exec -T "$pg_service" env "PGPASSWORD=$pg_password" psql --no-password --username="$pg_user" --dbname="$pg_database" --command="CREATE TABLE \"$probe\" (probe_id text PRIMARY KEY, payload text NOT NULL); INSERT INTO \"$probe\" VALUES ('issue-7', 'representative-record');" >/dev/null
"${source_compose[@]}" exec -T "$ch_service" clickhouse-client --user "$ch_user" --password "$ch_password" --database "$ch_database" --query="CREATE TABLE \`$probe\` (probe_id String, payload String) ENGINE = MergeTree ORDER BY probe_id; INSERT INTO \`$probe\` VALUES ('issue-7', 'representative-record')" >/dev/null

BACKUP_DESTINATION="$destination" BACKUP_SOURCE_ID=integration BACKUP_ID="$backup_id" "$root_dir/infra/scripts/backup.sh"
artifact="$destination/$backup_id"
BACKUP_ARTIFACT="$artifact" "$root_dir/infra/scripts/restore.sh" --validate-only
BACKUP_ARTIFACT="$artifact" "$root_dir/infra/scripts/restore.sh"

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
target_pg_probe="$("${target_compose[@]}" exec -T "$target_pg_service" env "PGPASSWORD=$target_pg_password" psql --no-password --tuples-only --no-align --username="$target_pg_user" --dbname="$target_pg_database" --command="SELECT payload FROM \"$probe\" WHERE probe_id = 'issue-7'")"
target_ch_probe="$("${target_compose[@]}" exec -T "$target_ch_service" clickhouse-client --user "$target_ch_user" --password "$target_ch_password" --database="$target_ch_database" --query="SELECT payload FROM \`$probe\` WHERE probe_id = 'issue-7'")"
[[ "$target_pg_probe" == *representative-record* && "$target_ch_probe" == *representative-record* ]]
printf 'real PostgreSQL + ClickHouse backup/restore probe passed\n'
