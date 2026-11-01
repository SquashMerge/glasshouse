import { expect, mock, spyOn, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createInternalLogCollector } from "../../src/db/internal-logs";
import { internalLogCollector } from "../../src/lib/internal-log-collector";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";

const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const queries: Array<{ sql: string; values: unknown[] }> = [];

const query = mock(async (sql: string, values: unknown[] = []) => {
	queries.push({ sql, values });
	if (sql.startsWith("SELECT authorization_allows_organization"))
		return { rows: [{ allowed: values[1] === ADMIN }] };
	if (sql.includes("AS global_count"))
		return { rows: [{ global_count: 0, org_count: 0, actor_count: 0 }] };
	if (sql.includes("SELECT count FROM collected"))
		return { rows: [{ count: 1 }] };
	if (sql.includes("SELECT checked.valid"))
		return {
			rows: [
				{
					valid: true,
					id: "33333333-3333-4333-8333-333333333333",
					recorded_at: "2026-11-01T00:01:00.000Z",
					severity: "warn",
					source: "api",
					message: "HTTP GET /v1/projects",
					context: { status: 403 },
					total: 1,
				},
			],
		};
	return { rows: [] };
});

const client = { query, release() {} };

const { createHandleListInternalLogs, listInternalLogsRoute } = await import(
	"../../src/routes/internal-logs"
);
const getPool = () => ({ connect: async () => client });

function createTestApp(useProductionHealth = false) {
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
	app.openapi(
		listInternalLogsRoute,
		useProductionHealth
			? createHandleListInternalLogs(getPool)
			: createHandleListInternalLogs(getPool, () => true),
	);
	return app;
}

const app = createTestApp();
const defaultHealthApp = createTestApp(true);

test("the public route reports collector insert failure and recovers after a successful insert", async () => {
	let failInsert = true;
	let finished: () => void = () => {};
	const writer = {
		connect: async () => ({
			query: async (sql: string) => {
				if (sql.startsWith("INSERT") && failInsert)
					throw new Error("private database detail");
				return { rows: [] };
			},
			release: () => finished(),
		}),
	};
	const onFailure = mock(() => {});
	const collector = createInternalLogCollector(writer as never, onFailure);
	const localApp = new OpenAPIHono();
	localApp.use("*", async (c, next) => {
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor: "test",
			actorId: ADMIN,
			organizationId: ORGANIZATION,
		});
		await next();
	});
	localApp.openapi(
		listInternalLogsRoute,
		createHandleListInternalLogs(
			() => ({ connect: async () => client }) as never,
			() => collector.healthy(),
		),
	);
	const entry = {
		organizationId: ORGANIZATION,
		severity: "info" as const,
		context: {
			route: "projects" as const,
			method: "GET" as const,
			status: 200,
			duration_ms: 1,
		},
	};
	let done = new Promise<void>((resolve) => {
		finished = resolve;
	});
	collector.record(entry);
	await done;
	await new Promise<void>((resolve) => setImmediate(resolve));
	const failed = await localApp.request("/v1/admin/logs");
	expect(failed.status).toBe(503);
	expect(onFailure).toHaveBeenCalledTimes(1);
	expect(onFailure).toHaveBeenCalledWith();
	expect(JSON.stringify(await failed.json())).not.toContain(
		"private database detail",
	);
	failInsert = false;
	done = new Promise<void>((resolve) => {
		finished = resolve;
	});
	collector.record(entry);
	await done;
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect((await localApp.request("/v1/admin/logs")).status).toBe(200);
	collector.close();
});

test("the default route reads production collector health after checking access", async () => {
	const health = spyOn(internalLogCollector, "healthy").mockReturnValue(false);
	try {
		queries.length = 0;
		expect(
			(
				await defaultHealthApp.request("/v1/admin/logs", {
					headers: { "x-test-actor": "user" },
				})
			).status,
		).toBe(403);
		expect((await defaultHealthApp.request("/v1/admin/logs")).status).toBe(503);
		expect(
			queries.some(({ sql }) => sql.includes("FROM internal_log_entries")),
		).toBe(false);
	} finally {
		health.mockRestore();
	}
});

test("route fixtures remain available when the production collector is unhealthy", async () => {
	const health = spyOn(internalLogCollector, "healthy").mockReturnValue(false);
	try {
		expect(
			(
				await app.request(
					"/v1/admin/logs?level=warn&source=api&q=projects&limit=25",
				)
			).status,
		).toBe(200);
		expect(
			(await app.request("/v1/admin/logs?time_from=0001-01-01T00:00:00Z"))
				.status,
		).toBe(200);
	} finally {
		health.mockRestore();
	}
});

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
	expect(queryCall?.sql).toContain("ORDER BY recorded_at DESC, id DESC");
});

test("internal logs reject malformed queries before authorization or storage access", async () => {
	queries.length = 0;
	const response = await app.request("/v1/admin/logs?limit=0");
	expect(response.status).toBe(400);
	expect(queries).toEqual([]);
});

test("rejects year zero time bounds before storage and accepts year one", async () => {
	for (const field of ["time_from", "time_to"]) {
		queries.length = 0;
		const response = await app.request(
			`/v1/admin/logs?${field}=0000-01-01T00:00:00Z`,
		);
		expect(response.status).toBe(400);
		expect(queries).toEqual([]);
	}
	expect(
		(await app.request("/v1/admin/logs?time_from=0001-01-01T00:00:00Z")).status,
	).toBe(200);
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
