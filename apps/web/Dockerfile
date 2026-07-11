FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
WORKDIR /app
COPY package.json bun.lockb* ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile --filter "@astraea/*"

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun --filter "@astraea/web" build

FROM oven/bun:1-alpine AS prod
WORKDIR /app
RUN apk add --no-cache libpq
COPY --from=build /app /app
ENV NODE_ENV=production
ENV WEB_PORT=5173
EXPOSE 5173
USER bun
CMD ["sh", "-c", "cd apps/web && bun run preview --host 0.0.0.0 --port 5173"]