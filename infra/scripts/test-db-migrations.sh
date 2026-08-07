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
  exec 3>&- || true
  rm -f "${UUID_LOCK_INPUT:-}" "${UUID_LOCK_OUTPUT:-}" "${UUID_INSERT_OUTPUT:-}"
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

docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  < "$ROOT/infra/scripts/test-db-migrations.assert.sql"

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
