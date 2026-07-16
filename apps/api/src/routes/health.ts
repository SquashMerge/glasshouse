import { createRoute } from "@hono/zod-openapi";
import { HealthResponse } from "../schemas/common.js";
import { pgPing } from "../db/postgres.js";
import { chPing } from "../db/clickhouse.js";
import { valkeyPing } from "../db/valkey.js";

const route = createRoute({
	method: "get",
	path: "/v1/health",
	tags: ["health"],
	summary: "Health check (Postgres + ClickHouse + Valkey)",
	description:
		"Returns 200 with all checks up, 503 with one or more checks down.",
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
	const [postgres, clickhouse, valkey] = await Promise.all([
		pgPing(),
		chPing(),
		valkeyPing(),
	]);
	const allUp = postgres === "up" && clickhouse === "up" && valkey === "up";
	const status = allUp ? "ok" : "degraded";
	const body = JSON.stringify({
		status,
		checks: { postgres, clickhouse, valkey },
	});
	return new Response(body, {
		status: allUp ? 200 : 503,
		headers: { "content-type": "application/json" },
	});
}
