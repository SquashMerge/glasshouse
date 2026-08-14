#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTAINER="astraea-db-migrations-${RANDOM}-${RANDOM}"
POSTGRES_USER="astraea_migrations"
POSTGRES_PASSWORD="astraea_migrations"
POSTGRES_DB="astraea_migrations"

cleanup() {
  [[ -n "${UUID_LOCK_PID:-}" ]] && kill "$UUID_LOCK_PID" >/dev/null 2>&1 || true
  [[ -n "${UUID_INSERT_PID:-}" ]] && kill "$UUID_INSERT_PID" >/dev/null 2>&1 || true
	[[ -n "${ADMIN_AUDIT_LOCK_PID:-}" ]] && kill "$ADMIN_AUDIT_LOCK_PID" >/dev/null 2>&1 || true
	[[ -n "${ADMIN_AUDIT_INSERT_PID:-}" ]] && kill "$ADMIN_AUDIT_INSERT_PID" >/dev/null 2>&1 || true
	[[ -n "${ORDER_HOLDER_PID:-}" ]] && kill "$ORDER_HOLDER_PID" >/dev/null 2>&1 || true
	[[ -n "${ORDER_CONTENDER_PID:-}" ]] && kill "$ORDER_CONTENDER_PID" >/dev/null 2>&1 || true
  exec 3>&- || true
	exec 5>&- || true
	exec 4>&- || true
  rm -f "${UUID_LOCK_INPUT:-}" "${UUID_LOCK_OUTPUT:-}" "${UUID_INSERT_OUTPUT:-}" "${ADMIN_AUDIT_LOCK_INPUT:-}" "${ADMIN_AUDIT_LOCK_OUTPUT:-}" "${ADMIN_AUDIT_INSERT_OUTPUT:-}" "${ORDER_HOLDER_INPUT:-}" "${ORDER_HOLDER_OUTPUT:-}" "${ORDER_CONTENDER_OUTPUT:-}"
  docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required for migration verification." >&2
  exit 1
}
command -v bun >/dev/null 2>&1 || {
  echo "Bun is required for migration verification." >&2
  exit 1
}

docker run --detach --rm \
  --name "$CONTAINER" \
  --env "POSTGRES_USER=$POSTGRES_USER" \
  --env "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
  --env "POSTGRES_DB=$POSTGRES_DB" \
  --publish 127.0.0.1::5432 \
  postgres:16-alpine >/dev/null

for _ in {1..30}; do
  if docker exec "$CONTAINER" \
    psql --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --command 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$CONTAINER" \
  psql --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --command 'SELECT 1' >/dev/null

PORT_BINDING="$(docker port "$CONTAINER" 5432/tcp)"
POSTGRES_PORT="${PORT_BINDING##*:}"

for migration in "$ROOT"/infra/db/migrations/000[1-7]_*.sql; do
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" < "$migration"
done

docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  < "$ROOT/infra/scripts/test-db-migrations.fixture.sql"

DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB" \
  UI_USERNAME=bootstrap-owner UI_PASSWORD=bootstrap-password ASTRAEA_BOOTSTRAP_OWNER_USERNAME=bootstrap-owner \
  bun run --cwd "$ROOT/apps/api" db:migrate
DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB" \
  UI_USERNAME=bootstrap-owner UI_PASSWORD=bootstrap-password ASTRAEA_BOOTSTRAP_OWNER_USERNAME=bootstrap-owner \
  bun run --cwd "$ROOT/apps/api" db:migrate

# These races require two live PostgreSQL connections. Keeping them here makes
# the revocation linearization checks mandatory in the Docker-backed CI job.
DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB" \
  UI_USERNAME=bootstrap-owner UI_PASSWORD=bootstrap-password ASTRAEA_BOOTSTRAP_OWNER_USERNAME=bootstrap-owner \
  bun test --cwd "$ROOT/apps/api" tests/integration/authorization-revocation-serialization.test.ts

run_uuid_advisory_serialization_check() {
  local project_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  local organization_id="00000000-0000-4000-8000-000000000001"
  local lock_state= lock_waited=
  UUID_LOCK_INPUT="$(mktemp)"
  UUID_LOCK_OUTPUT="$(mktemp)"
  UUID_INSERT_OUTPUT="$(mktemp)"
  rm "$UUID_LOCK_INPUT"
  mkfifo "$UUID_LOCK_INPUT"

  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    < "$UUID_LOCK_INPUT" > "$UUID_LOCK_OUTPUT" 2>&1 &
  UUID_LOCK_PID=$!
  exec 3>"$UUID_LOCK_INPUT"
  printf "BEGIN; SELECT lock_project_audit_provenance('%s');\n" "$project_id" >&3

  for _ in {1..50}; do
    lock_state="$(docker exec "$CONTAINER" psql --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "SELECT pg_try_advisory_xact_lock(hashtextextended('$project_id', 0))")"
    [[ "$lock_state" == "f" ]] && break
    sleep 0.1
  done
  if [[ "$lock_state" != "f" ]]; then
    echo "advisory lock holder did not acquire the project UUID lock" >&2
    exit 1
  fi

  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --command "INSERT INTO projects (id, name, slug, organization_id) VALUES ('$project_id', 'UUID Lock Serialization', 'uuid-lock-serialization', '$organization_id')" \
    > "$UUID_INSERT_OUTPUT" 2>&1 &
  UUID_INSERT_PID=$!
  for _ in {1..50}; do
    lock_waited="$(docker exec "$CONTAINER" psql --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO projects (id, name, slug, organization_id)%')")"
    [[ "$lock_waited" == "t" ]] && break
    sleep 0.1
  done
  if [[ "$lock_waited" != "t" ]]; then
    echo "same-UUID project insert did not wait for the advisory lock" >&2
    exit 1
  fi

  printf 'COMMIT;\n' >&3
  exec 3>&-
  wait "$UUID_LOCK_PID"
  wait "$UUID_INSERT_PID"
  docker exec "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --command "DELETE FROM projects WHERE id = '$project_id'"
  rm -f "$UUID_LOCK_INPUT" "$UUID_LOCK_OUTPUT" "$UUID_INSERT_OUTPUT"
  UUID_LOCK_PID=
  UUID_INSERT_PID=
  UUID_LOCK_INPUT=
  UUID_LOCK_OUTPUT=
  UUID_INSERT_OUTPUT=
}

run_uuid_advisory_serialization_check

run_audit_lock_order_serialization_check() {
	local project_id="11111111-1111-1111-1111-111111111111"
	local holder_ready= contender_waiting=
	ORDER_HOLDER_INPUT="$(mktemp)"
	ORDER_HOLDER_OUTPUT="$(mktemp)"
	ORDER_CONTENDER_OUTPUT="$(mktemp)"
	rm "$ORDER_HOLDER_INPUT"
	mkfifo "$ORDER_HOLDER_INPUT"

	docker exec --interactive "$CONTAINER" \
		psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
		< "$ORDER_HOLDER_INPUT" > "$ORDER_HOLDER_OUTPUT" 2>&1 &
	ORDER_HOLDER_PID=$!
	exec 4>"$ORDER_HOLDER_INPUT"
	printf "BEGIN; SELECT id FROM projects WHERE id = '%s' FOR UPDATE; SELECT lock_project_audit_provenance('%s'); SELECT id FROM governance_retention_runs WHERE project_id = '%s' FOR UPDATE;\n" "$project_id" "$project_id" "$project_id" >&4

	for _ in {1..50}; do
		holder_ready="$(docker exec "$CONTAINER" psql --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "SELECT pg_try_advisory_xact_lock(hashtextextended('$project_id', 0))")"
		[[ "$holder_ready" == "f" ]] && break
		sleep 0.1
	done
	if [[ "$holder_ready" != "f" ]]; then
		echo "finalizer-style audit lock holder did not acquire the project lock" >&2
		exit 1
	fi

	# Retention finalization takes the Project fence before its audit UUID lock.
	docker exec --interactive "$CONTAINER" \
		psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
		--command "BEGIN; SELECT id FROM projects WHERE id = '$project_id' FOR UPDATE; SELECT lock_project_audit_provenance('$project_id'); SELECT id FROM governance_retention_runs WHERE project_id = '$project_id' FOR UPDATE; COMMIT;" \
		> "$ORDER_CONTENDER_OUTPUT" 2>&1 &
	ORDER_CONTENDER_PID=$!
	for _ in {1..50}; do
		contender_waiting="$(docker exec "$CONTAINER" psql --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'BEGIN; SELECT id FROM projects WHERE id = ''$project_id'' FOR UPDATE%')")"
		[[ "$contender_waiting" == "t" ]] && break
		sleep 0.1
	done
	if [[ "$contender_waiting" != "t" ]]; then
		echo "retry/retention contender did not serialize behind the project fence" >&2
		exit 1
	fi

	printf 'COMMIT;\n' >&4
	exec 4>&-
	timeout 10s bash -c "while kill -0 '$ORDER_HOLDER_PID' 2>/dev/null; do sleep 0.1; done"
	timeout 10s bash -c "while kill -0 '$ORDER_CONTENDER_PID' 2>/dev/null; do sleep 0.1; done"
	wait "$ORDER_HOLDER_PID"
	wait "$ORDER_CONTENDER_PID"
	rm -f "$ORDER_HOLDER_INPUT" "$ORDER_HOLDER_OUTPUT" "$ORDER_CONTENDER_OUTPUT"
	ORDER_HOLDER_PID=
	ORDER_CONTENDER_PID=
	ORDER_HOLDER_INPUT=
	ORDER_HOLDER_OUTPUT=
	ORDER_CONTENDER_OUTPUT=
}

run_audit_lock_order_serialization_check

docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  < "$ROOT/infra/scripts/test-db-migrations.assert.sql"

UPGRADE_0039_DATABASE="${POSTGRES_DB}_0039_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0039_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0039_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0039_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0039_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0039.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0039_DATABASE" \
  < "$ROOT/infra/db/migrations/0039_durable_basic_auth_actors.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0039_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0039.assert.sql"

UPGRADE_0040_DATABASE="${POSTGRES_DB}_0040_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0040_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0040_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0040_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0040_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0040.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0040_DATABASE" \
  < "$ROOT/infra/db/migrations/0040_internal_evaluation_worker_actors.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0040_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0040.assert.sql"

UPGRADE_0041_DATABASE="${POSTGRES_DB}_0041_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0041_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0041_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0041_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0041_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0041.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0041_DATABASE" \
  < "$ROOT/infra/db/migrations/0041_admin_user_read_only_authorization.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0041_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0041.assert.sql"

UPGRADE_0042_DATABASE="${POSTGRES_DB}_0042_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0042_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0042_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0042_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0042_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0042.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0042_DATABASE" \
  < "$ROOT/infra/db/migrations/0042_experiment_requester_authorization.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0042_DATABASE" \
  < "$ROOT/infra/db/migrations/0042_experiment_requester_authorization.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0042_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0042.assert.sql"

UPGRADE_0043_DATABASE="${POSTGRES_DB}_0043_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0043_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0043_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0043_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0043_DATABASE" \
  < "$ROOT/infra/db/migrations/0043_authorization_revocation_fence.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0043_DATABASE" \
  < "$ROOT/infra/db/migrations/0043_authorization_revocation_fence.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0043_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0043.assert.sql"

UPGRADE_0044_DATABASE="${POSTGRES_DB}_0044_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0044_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0044_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0044_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0044_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0044.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0044_DATABASE" \
  < "$ROOT/infra/db/migrations/0044_execution_admission_cancellation.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0044_DATABASE" \
  < "$ROOT/infra/db/migrations/0044_execution_admission_cancellation.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0044_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0044.assert.sql"

UPGRADE_0046_DATABASE="${POSTGRES_DB}_0046_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0046_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0046_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0046_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0046_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0044.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0046_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0046.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0046_DATABASE" \
  < "$ROOT/infra/db/migrations/0046_authorization_lock_order_and_effect_keys.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0046_DATABASE" \
  < "$ROOT/infra/db/migrations/0046_authorization_lock_order_and_effect_keys.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0046_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0046.assert.sql"

UPGRADE_0047_DATABASE="${POSTGRES_DB}_0047_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0047_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0047_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0047_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0047_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0044.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0047_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0047.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0047_DATABASE" \
  < "$ROOT/infra/db/migrations/0047_durable_execution_effects.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0047_DATABASE" \
  < "$ROOT/infra/db/migrations/0047_durable_execution_effects.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0047_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0047.assert.sql"

UPGRADE_0049_DATABASE="${POSTGRES_DB}_0049_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0049_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0049_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0049_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0049_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0049.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0049_DATABASE" \
  < "$ROOT/infra/db/migrations/0049_execution_admission_cancellation_identity_fix.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0049_DATABASE" \
  < "$ROOT/infra/db/migrations/0049_execution_admission_cancellation_identity_fix.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0049_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0049.assert.sql"

UPGRADE_0050_DATABASE="${POSTGRES_DB}_0050_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0050_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0050_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0050_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0050_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0050.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0050_DATABASE" \
  < "$ROOT/infra/db/migrations/0050_authorization_role_migration_quarantine_tenant_scope.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0050_DATABASE" \
  < "$ROOT/infra/db/migrations/0050_authorization_role_migration_quarantine_tenant_scope.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0050_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0050.assert.sql"

UPGRADE_0051_DATABASE="${POSTGRES_DB}_0051_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0051_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0051_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0051_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0051_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0051.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0051_DATABASE" \
  < "$ROOT/infra/db/migrations/0051_admin_membership_project_grants_recovery.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0051_DATABASE" \
  < "$ROOT/infra/db/migrations/0051_admin_membership_project_grants_recovery.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0051_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0051.assert.sql"

UPGRADE_0052_DATABASE="${POSTGRES_DB}_0052_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0052_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0051_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0052_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0052_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0051.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0052_DATABASE" \
  < "$ROOT/infra/db/migrations/0051_admin_membership_project_grants_recovery.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0052_DATABASE" \
  < "$ROOT/infra/db/migrations/0052_durable_authorization_revocation_cancellation.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0052_DATABASE" \
  < "$ROOT/infra/db/migrations/0052_durable_authorization_revocation_cancellation.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0052_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0052.assert.sql"

UPGRADE_0053_DATABASE="${POSTGRES_DB}_0053_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0053_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0051_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0053_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0053_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0051.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0053_DATABASE" \
  < "$ROOT/infra/db/migrations/0051_admin_membership_project_grants_recovery.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0053_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0053.fixture.sql"
for migration in \
  "$ROOT/infra/db/migrations/0052_durable_authorization_revocation_cancellation.sql" \
  "$ROOT/infra/db/migrations/0053_project_audit_provenance_serialization_recovery.sql" \
  "$ROOT/infra/db/migrations/0053_project_audit_provenance_serialization_recovery.sql"; do
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0053_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0053_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0053.assert.sql"

run_admin_access_audit_provenance_serialization_check() {
	local database="$1"
	local project_id="54000000-0000-4000-8000-000000000001"
	local organization_id="51000000-0000-4000-8000-000000000001"
	local owner_id="51000000-0000-4000-8000-000000000101"
	local reader_id="51000000-0000-4000-8000-000000000102"
	local lock_state= lock_waited= event_persisted=
	ADMIN_AUDIT_LOCK_INPUT="$(mktemp)"
	ADMIN_AUDIT_LOCK_OUTPUT="$(mktemp)"
	ADMIN_AUDIT_INSERT_OUTPUT="$(mktemp)"
	rm "$ADMIN_AUDIT_LOCK_INPUT"
	mkfifo "$ADMIN_AUDIT_LOCK_INPUT"

	docker exec --interactive "$CONTAINER" \
		psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" \
		< "$ADMIN_AUDIT_LOCK_INPUT" > "$ADMIN_AUDIT_LOCK_OUTPUT" 2>&1 &
	ADMIN_AUDIT_LOCK_PID=$!
	exec 5>"$ADMIN_AUDIT_LOCK_INPUT"
	printf "BEGIN; SELECT lock_project_audit_provenance('%s');\n" "$project_id" >&5

	for _ in {1..50}; do
		lock_state="$(docker exec "$CONTAINER" psql --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$database" --command "SELECT pg_try_advisory_xact_lock(hashtextextended('$project_id', 0))")"
		[[ "$lock_state" == "f" ]] && break
		sleep 0.1
	done
	if [[ "$lock_state" != "f" ]]; then
		echo "admin audit advisory-lock holder did not acquire the project UUID lock" >&2
		exit 1
	fi

	docker exec --interactive "$CONTAINER" \
		psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" \
		--command "INSERT INTO admin_access_audit_events (organization_id, project_id, actor_id, target_actor_id, action, correlation_id) VALUES ('$organization_id', '$project_id', '$owner_id', '$reader_id', 'project_grant_set', gen_random_uuid())" \
		> "$ADMIN_AUDIT_INSERT_OUTPUT" 2>&1 &
	ADMIN_AUDIT_INSERT_PID=$!
	for _ in {1..50}; do
		lock_waited="$(docker exec "$CONTAINER" psql --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$database" --command "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO admin_access_audit_events%')")"
		[[ "$lock_waited" == "t" ]] && break
		sleep 0.1
	done
	if [[ "$lock_waited" != "t" ]]; then
		echo "project-scoped admin audit insert did not wait for the advisory lock" >&2
		exit 1
	fi

	printf 'COMMIT;\n' >&5
	exec 5>&-
	timeout 10s bash -c "while kill -0 '$ADMIN_AUDIT_LOCK_PID' 2>/dev/null; do sleep 0.1; done"
	timeout 10s bash -c "while kill -0 '$ADMIN_AUDIT_INSERT_PID' 2>/dev/null; do sleep 0.1; done"
	wait "$ADMIN_AUDIT_LOCK_PID"
	wait "$ADMIN_AUDIT_INSERT_PID"
	event_persisted="$(docker exec "$CONTAINER" psql --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$database" --command "SELECT EXISTS (SELECT 1 FROM admin_access_audit_events WHERE organization_id = '$organization_id' AND project_id = '$project_id' AND actor_id = '$owner_id' AND target_actor_id = '$reader_id' AND action = 'project_grant_set')")"
	if [[ "$event_persisted" != "t" ]]; then
		echo "admin audit event did not persist after advisory-lock serialization" >&2
		exit 1
	fi
	rm -f "$ADMIN_AUDIT_LOCK_INPUT" "$ADMIN_AUDIT_LOCK_OUTPUT" "$ADMIN_AUDIT_INSERT_OUTPUT"
	ADMIN_AUDIT_LOCK_PID=
	ADMIN_AUDIT_INSERT_PID=
	ADMIN_AUDIT_LOCK_INPUT=
	ADMIN_AUDIT_LOCK_OUTPUT=
	ADMIN_AUDIT_INSERT_OUTPUT=
}

UPGRADE_0054_DATABASE="${POSTGRES_DB}_0054_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0054_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0051_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0054_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0054_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0051.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0054_DATABASE" \
  < "$ROOT/infra/db/migrations/0051_admin_membership_project_grants_recovery.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0054_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0053.fixture.sql"
for migration in \
  "$ROOT/infra/db/migrations/0052_durable_authorization_revocation_cancellation.sql" \
  "$ROOT/infra/db/migrations/0053_project_audit_provenance_serialization_recovery.sql" \
  "$ROOT/infra/db/migrations/0053_project_audit_provenance_serialization_recovery.sql" \
  "$ROOT/infra/db/migrations/0054_admin_access_audit_provenance_serialization.sql" \
  "$ROOT/infra/db/migrations/0054_admin_access_audit_provenance_serialization.sql"; do
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0054_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0054_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0054.fixture.sql"
run_admin_access_audit_provenance_serialization_check "$UPGRADE_0054_DATABASE"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0054_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0054.assert.sql"

UPGRADE_0064_DATABASE="${POSTGRES_DB}_0064_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0064_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0064_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0064_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0064_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0064.fixture.sql"
for migration in \
  "$ROOT/infra/db/migrations/0064_legacy_dataset_item_project_scope.sql" \
  "$ROOT/infra/db/migrations/0064_legacy_dataset_item_project_scope.sql"; do
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0064_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0064_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0064.assert.sql"

UPGRADE_0050_NULL_ORGANIZATION_DATABASE="${POSTGRES_DB}_0050_null_organization"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0050_NULL_ORGANIZATION_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0050_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0050_NULL_ORGANIZATION_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0050_NULL_ORGANIZATION_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0050-null-organization.fixture.sql"
if migration_error="$(docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0050_NULL_ORGANIZATION_DATABASE" \
  < "$ROOT/infra/db/migrations/0050_authorization_role_migration_quarantine_tenant_scope.sql" 2>&1)"; then
  echo "0050 migration accepted a quarantine record without organization scope" >&2
  exit 1
fi
if [[ "$migration_error" != *"authorization role migration quarantine rows missing organization scope"* ]]; then
  echo "0050 quarantine tenant-scope preflight failed unexpectedly: $migration_error" >&2
  exit 1
fi

UPGRADE_0040_MISMATCH_DATABASE="${POSTGRES_DB}_0040_mismatch"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0040_MISMATCH_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0040_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0040_MISMATCH_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0040_MISMATCH_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0040-mismatch.fixture.sql"
if migration_error="$(docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0040_MISMATCH_DATABASE" \
  < "$ROOT/infra/db/migrations/0040_internal_evaluation_worker_actors.sql" 2>&1)"; then
  echo "0040 migration accepted a mismatched internal evaluation actor" >&2
  exit 1
fi
if [[ "$migration_error" != *"internal evaluation worker identity does not match organization"* ]]; then
  echo "0040 migration mismatch preflight failed unexpectedly: $migration_error" >&2
  exit 1
fi

UPGRADE_0040_CROSS_PROVIDER_COLLISION_DATABASE="${POSTGRES_DB}_0040_cross_provider_collision"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0040_CROSS_PROVIDER_COLLISION_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0040_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0040_CROSS_PROVIDER_COLLISION_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0040_CROSS_PROVIDER_COLLISION_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0040-cross-provider-collision.fixture.sql"
if migration_error="$(docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0040_CROSS_PROVIDER_COLLISION_DATABASE" \
  < "$ROOT/infra/db/migrations/0040_internal_evaluation_worker_actors.sql" 2>&1)"; then
  echo "0040 migration accepted a cross-provider internal actor ID collision" >&2
  exit 1
fi
if [[ "$migration_error" != *"internal evaluation worker actor ID is already linked or orphaned"* ]]; then
  echo "0040 cross-provider actor collision preflight failed unexpectedly: $migration_error" >&2
  exit 1
fi

UPGRADE_DATABASE="${POSTGRES_DB}_0028_upgrade"
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0028_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0028.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_DATABASE" \
  < "$ROOT/infra/db/migrations/0028_project_authorization_audit_project_scope.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0028.assert.sql"

UPGRADE_0033_DATABASE="${POSTGRES_DB}_0033_upgrade"
MIGRATION_0033="$(<"$ROOT/infra/db/migrations/0033_project_default_and_deletion_lifecycle.sql")"
if [[ "$MIGRATION_0033" != *$'SET default_project_id = (\n    SELECT project.id\n    FROM projects AS project\n    WHERE project.organization_id = organization.id\n      AND project.status = \'active\'\n    ORDER BY (project.slug = \'default\') DESC, project.created_at, project.id\n    LIMIT 1\n)'* \
  || "$MIGRATION_0033" != *$'WHERE organization.default_project_id IS NULL\n  AND EXISTS (\n      SELECT 1\n      FROM projects AS project\n      WHERE project.organization_id = organization.id\n        AND project.status = \'active\'\n  );'* \
  || "$MIGRATION_0033" == *"FROM LATERAL"* ]]; then
  echo "0033 must use a correlated, active-project default backfill without LATERAL" >&2
  exit 1
fi
docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$UPGRADE_0033_DATABASE"
for migration in "$ROOT"/infra/db/migrations/*.sql; do
  [[ "$migration" == *"/0033_"* ]] && break
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0033_DATABASE" < "$migration"
done
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0033_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0033.fixture.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0033_DATABASE" \
  < "$ROOT/infra/db/migrations/0033_project_default_and_deletion_lifecycle.sql"
docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$UPGRADE_0033_DATABASE" \
  < "$ROOT/infra/scripts/test-db-migrations-0033.assert.sql"

run_fail_closed_case() {
  local database="$1"
  local fixture="$2"
  local assertion="$3"
  local expected_ids="$4"
  local migration_error

  docker exec "$CONTAINER" createdb --username "$POSTGRES_USER" "$database"
  for migration in "$ROOT"/infra/db/migrations/000[1-8]_*.sql; do
    docker exec --interactive "$CONTAINER" \
      psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" < "$migration"
  done
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" < "$fixture"
  if migration_error="$(docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" \
    < "$ROOT/infra/db/migrations/0009_prompt_management_canonical.sql" 2>&1)"; then
    echo "0009 migration accepted malformed canonical messages" >&2
    exit 1
  fi
  if [[ "$migration_error" != *"$expected_ids"* ]]; then
    echo "0009 migration preflight did not name every invalid prompt UUID" >&2
    exit 1
  fi
  docker exec --interactive "$CONTAINER" \
    psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" < "$assertion"
}

run_fail_closed_case \
  "${POSTGRES_DB}_fail_closed" \
  "$ROOT/infra/scripts/test-db-migrations-fail-closed.sql" \
  "$ROOT/infra/scripts/test-db-migrations-fail-closed.assert.sql" \
  "eeeeeeee-0000-0000-0000-000000000001, ffffffff-0000-0000-0000-000000000001"
run_fail_closed_case \
  "${POSTGRES_DB}_fail_closed_missing_role" \
  "$ROOT/infra/scripts/test-db-migrations-fail-closed-missing-role.sql" \
  "$ROOT/infra/scripts/test-db-migrations-fail-closed-missing-role.assert.sql" \
  "44444444-0000-0000-0000-000000000001"
run_fail_closed_case \
  "${POSTGRES_DB}_fail_closed_missing_content" \
  "$ROOT/infra/scripts/test-db-migrations-fail-closed-missing-content.sql" \
  "$ROOT/infra/scripts/test-db-migrations-fail-closed-missing-content.assert.sql" \
  "55555555-0000-0000-0000-000000000001"
