FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile --filter "@glasshouse/*"

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
RUN bun --filter "@glasshouse/web" build

FROM oven/bun:1.3.14-alpine AS prod
WORKDIR /app
RUN apk add --no-cache libpq wget
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/web/vite.config.ts ./apps/web/vite.config.ts
RUN chown -R bun:bun /app
ENV NODE_ENV=production
ENV WEB_PORT=5173
EXPOSE 5173
USER bun
CMD ["sh", "-c", "cd apps/web && bun run preview --host 0.0.0.0 --port 5173"]
