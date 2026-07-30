#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTAINER="astraea-db-migrations-${RANDOM}-${RANDOM}"
POSTGRES_USER="astraea_migrations"
POSTGRES_PASSWORD="astraea_migrations"
POSTGRES_DB="astraea_migrations"

cleanup() {
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

docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  < "$ROOT/infra/scripts/test-db-migrations.assert.sql"

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
