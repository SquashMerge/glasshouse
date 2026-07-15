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
  if docker exec "$CONTAINER" pg_isready --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >/dev/null

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
  bun --cwd "$ROOT/apps/api" run db:migrate
DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB" \
  bun --cwd "$ROOT/apps/api" run db:migrate

docker exec --interactive "$CONTAINER" \
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  < "$ROOT/infra/scripts/test-db-migrations.assert.sql"
