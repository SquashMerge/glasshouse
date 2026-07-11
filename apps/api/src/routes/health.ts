import { createRoute } from "@hono/zod-openapi";
import { HealthResponse } from "../schemas/common.js";
import { pgPing } from "../db/postgres.js";
import { chPing } from "../db/clickhouse.js";
import { redisPing } from "../db/redis.js";

const route = createRoute({
  method: "get",
  path: "/v1/health",
  tags: ["health"],
  summary: "Health check (Postgres + ClickHouse + Redis)",
  description: "Returns 200 with all checks up, 503 with one or more checks down.",
  responses: {
    200: {
      description: "All checks up",
      content: { "application/json": { schema: HealthResponse } },
    },
    503: {
      description: "One or more checks down",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

export const healthRoute = route;

export async function handleHealth(): Promise<Response> {
  const [postgres, clickhouse, redis] = await Promise.all([
    pgPing(),
    chPing(),
    redisPing(),
  ]);
  const allUp = postgres === "up" && clickhouse === "up" && redis === "up";
  const status = allUp ? "ok" : "degraded";
  const body = JSON.stringify({ status, checks: { postgres, clickhouse, redis } });
  return new Response(body, {
    status: allUp ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}