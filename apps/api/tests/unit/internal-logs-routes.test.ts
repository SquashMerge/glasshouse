import { expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";

const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const queries: Array<{ sql: string; values: unknown[] }> = [];

const query = mock(async (sql: string, values: unknown[] = []) => {
	queries.push({ sql, values });
	if (sql.startsWith("SELECT authorization_allows_organization"))
		return { rows: [{ allowed: values[1] === ADMIN }] };
	if (sql.includes("FROM internal_log_entries"))
		return {
			rows: [
				{
					id: "33333333-3333-4333-8333-333333333333",
					recorded_at: new Date("2026-11-01T00:01:00.000Z"),
					severity: "warn",
					source: "api",
					message: "HTTP GET /v1/projects",
					context: { status: 403 },
					total: "1",
				},
			],
		};
	return { rows: [] };
});

const client = { query, release() {} };

const postgres = await import("../../src/db/postgres");
mock.module("../../src/db/postgres", () => ({
	...postgres,
	pgPool: () => ({ query, connect: async () => client }),
}));

const { handleListInternalLogs, listInternalLogsRoute } = await import(
	"../../src/routes/internal-logs"
);

const app = new OpenAPIHono({
	defaultHook: (result, c) =>
		result.success
			? undefined
			: c.json(
					{ code: "BAD_REQUEST", message: "Request validation failed" },
					400,
				),
});
app.use("*", async (c, next) => {
	c.set(TRUSTED_TENANT_CONTEXT_KEY, {
		actor: "test",
		actorId: c.req.header("x-test-actor") === "user" ? USER : ADMIN,
		organizationId: ORGANIZATION,
	});
	await next();
});
app.openapi(listInternalLogsRoute, handleListInternalLogs);

test("internal logs require an Admin and scope the filtered query to their organization", async () => {
	queries.length = 0;
	const denied = await app.request("/v1/admin/logs", {
		headers: { "x-test-actor": "user" },
	});
	expect(denied.status).toBe(403);
	expect(
		queries.some(({ sql }) => sql.includes("FROM internal_log_entries")),
	).toBe(false);

	queries.length = 0;
	const allowed = await app.request(
		"/v1/admin/logs?level=warn&source=api&q=projects&limit=25",
	);
	expect(allowed.status).toBe(200);
	expect(await allowed.json()).toMatchObject({
		items: [{ source: "api", context: { status: 403 } }],
		total: 1,
		sources: ["api"],
		retention_days: 14,
	});
	const queryCall = queries.find(({ sql }) =>
		sql.includes("FROM internal_log_entries"),
	);
	expect(queryCall?.values).toContain(ORGANIZATION);
	expect(queryCall?.sql).toContain("ORDER BY cursor_recorded_at DESC, id DESC");
});

test("internal logs reject malformed queries before authorization or storage access", async () => {
	queries.length = 0;
	const response = await app.request("/v1/admin/logs?limit=0");
	expect(response.status).toBe(400);
	expect(queries).toEqual([]);
});

test("internal logs report a disabled collector without querying stored records", async () => {
	const previous = process.env.GLASSHOUSE_INTERNAL_LOGS_ENABLED;
	process.env.GLASSHOUSE_INTERNAL_LOGS_ENABLED = "false";
	queries.length = 0;
	try {
		const response = await app.request("/v1/admin/logs");
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			code: "SERVICE_UNAVAILABLE",
			message: "Internal log collection is unavailable on this deployment",
		});
		expect(
			queries.some(({ sql }) => sql.includes("FROM internal_log_entries")),
		).toBe(false);
	} finally {
		if (previous === undefined)
			delete process.env.GLASSHOUSE_INTERNAL_LOGS_ENABLED;
		else process.env.GLASSHOUSE_INTERNAL_LOGS_ENABLED = previous;
	}
});
