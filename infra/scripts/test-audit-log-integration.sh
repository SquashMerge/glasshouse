#!/usr/bin/env bash
set -euo pipefail

container="glasshouse-audit-log-$$-${RANDOM}"
network="${container}-network"

cleanup() {
	docker rm --force "$container" >/dev/null 2>&1 || true
	docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker info >/dev/null
docker network create "$network" >/dev/null
docker run --detach --rm --name "$container" --network "$network" \
	--env POSTGRES_DB=glasshouse \
	--env POSTGRES_PASSWORD=glasshouse-audit-log-test \
	--env POSTGRES_USER=glasshouse \
	--health-cmd "pg_isready -U glasshouse -d glasshouse" \
	--health-interval 1s \
	--health-retries 60 \
	--health-timeout 1s \
	--publish 127.0.0.1::5432 \
	postgres:18.6-alpine >/dev/null

for _ in $(seq 1 60); do
	if [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = "healthy" ]; then
		break
	fi
	sleep 1
done

if [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" != "healthy" ]; then
	docker logs "$container" >&2
	exit 1
fi

port="$(docker port "$container" 5432/tcp | head -n 1 | awk -F: '{print $NF}')"
DATABASE_URL="postgresql://glasshouse:glasshouse-audit-log-test@127.0.0.1:${port}/glasshouse" \
	bun --cwd apps/api test tests/integration/audit-log.test.ts
