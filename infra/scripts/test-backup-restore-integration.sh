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
target_ch_client_config="$(create_clickhouse_client_config "$target_ch_service" "$target_ch_user" "$target_ch_password" "${target_compose[@]}")"
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
