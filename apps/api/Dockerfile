FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile

FROM base AS prod-deps
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile --production --filter "glasshouse" --filter "@glasshouse/api"

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY . .
RUN bun --filter "@glasshouse/api" build

FROM oven/bun:1.3.14-alpine AS prod
WORKDIR /app
RUN apk upgrade --no-cache && apk add --no-cache libpq python3 py3-pip util-linux wget && python3 -m venv /opt/gepa
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/api/src ./apps/api/src
COPY --from=build /app/infra/db/migrations ./infra/db/migrations
COPY --from=build /app/infra/db/clickhouse ./infra/db/clickhouse
COPY --from=build /app/infra/scripts/verify-pg-migration-filenames.ts ./infra/scripts/verify-pg-migration-filenames.ts
COPY --from=build /app/worker/gepa_worker.py ./worker/gepa_worker.py
COPY --from=build /app/worker/dev_cli_llm.py ./worker/dev_cli_llm.py
COPY --from=build /app/worker/__init__.py ./worker/__init__.py
COPY --from=build /app/worker/requirements.lock ./worker/requirements.lock
RUN /opt/gepa/bin/pip install --no-cache-dir --require-hashes -r /app/worker/requirements.lock && /opt/gepa/bin/python /app/worker/gepa_worker.py --smoke
ENV NODE_ENV=production
ENV API_PORT=3000
ENV GEPA_PYTHON=/opt/gepa/bin/python
EXPOSE 3000
USER bun
CMD ["sh", "-c", "cd apps/api && bun run start"]
