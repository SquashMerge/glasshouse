FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun --filter "@astraea/api" build

FROM oven/bun:1.3.14-alpine AS prod
WORKDIR /app
RUN apk add --no-cache libpq python3 py3-pip wget && python3 -m venv /opt/gepa
COPY --from=build /app /app
RUN /opt/gepa/bin/pip install --no-cache-dir -r /app/worker/requirements.txt && /opt/gepa/bin/python /app/worker/gepa_worker.py --smoke
ENV NODE_ENV=production
ENV API_PORT=3000
ENV GEPA_PYTHON=/opt/gepa/bin/python
EXPOSE 3000
USER bun
CMD ["sh", "-c", "cd apps/api && bun run db:migrate && bun run ch:migrate && bun run src/index.ts"]
