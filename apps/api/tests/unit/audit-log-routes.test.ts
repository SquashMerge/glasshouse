import { expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";

const organizationId = "00000000-0000-4000-8000-000000000001";
const actorId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-822222222222";
const createdAt = "2026-11-01T12:00:00.123456Z";

const postgres = await import("../../src/db/postgres.js");
const { TRUSTED_TENANT_CONTEXT_KEY } = await import(
	"../../src/middleware/auth.js"
);
const query = mock(async () => ({ rows: [] }));
mock.module("../../src/db/postgres.js", () => ({
	...postgres,
	pgPool: () => ({ query }),
}));
const { auditLogRoute, handleListAuditEvents } = await import(
	"../../src/routes/audit-log.js"
);

test("lists only audit-safe, cursor-paged events for every authorized role", async () => {
	let statement = "";
	let parameters: unknown[] = [];
	query.mockImplementation(async (sql: string, values: unknown[]) => {
		statement = sql;
		parameters = values;
		return {
			rows: [
				{
					id: eventId,
					source: "project_authorization",
					actor: "alice",
					action: "project_updated",
					resource_type: "project",
					resource_id: "33333333-3333-4333-8333-333333333333",
					outcome: null,
					created_at: createdAt,
				},
				{
					id: "22222222-2222-4222-8222-222222222223",
					source: "project_authorization",
					actor: "alice",
					action: "project_created",
					resource_type: "project",
					resource_id: "33333333-3333-4333-8333-333333333333",
					outcome: null,
					created_at: createdAt,
				},
			],
		};
	});
	const app = new OpenAPIHono({
		defaultHook: (result, c) =>
			result.success
				? undefined
				: c.json(
						{ code: "BAD_REQUEST", message: "Request validation failed" },
						400,
					),
	});
	app.use("/v1/*", async (c, next) => {
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor: "reader",
			actorId,
			organizationId,
		});
		await next();
	});
	app.openapi(auditLogRoute, handleListAuditEvents);

	try {
		const response = await app.request(
			"http://localhost/v1/audit-events?limit=1&actor=alice&action=project_updated&resource=project&outcome=success&search=alice",
		);
		const body = await response.json();
		expect(query).toHaveBeenCalled();
		expect(response.status).toBe(200);
		expect(statement).toContain("authorization_allows_project");
		expect(statement).toContain("'audit_read'");
		expect(statement).toContain(
			"e.created_at DESC, e.event_id DESC, e.source DESC",
		);
		expect(statement).toContain("ILIKE");
		expect(statement).not.toContain("token");
		expect(parameters).toContain(organizationId);
		expect(body).toEqual({
			items: [
				{
					id: eventId,
					source: "project_authorization",
					actor: "alice",
					action: "project_updated",
					resource_type: "project",
					resource_id: "33333333-3333-4333-8333-333333333333",
					outcome: null,
					created_at: createdAt,
					details: { source: "project_authorization" },
				},
			],
			next_cursor: expect.any(String),
		});
		expect(
			JSON.parse(Buffer.from(body.next_cursor, "base64url").toString("utf8"))
				.created_at,
		).toBe(createdAt);
	} finally {
		query.mockReset();
	}
});

test("continuation accepts its own cursor with maximum-length Unicode filters", async () => {
	const row = {
		id: eventId,
		source: "project_authorization",
		actor: "alice",
		action: "project_updated",
		resource_type: "project",
		resource_id: null,
		outcome: null,
		created_at: createdAt,
	};
	query.mockImplementation(async () => ({ rows: [row, row] }));
	const app = new OpenAPIHono();
	app.use("/v1/*", async (c, next) => {
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor: "reader",
			actorId,
			organizationId,
		});
		await next();
	});
	app.openapi(auditLogRoute, handleListAuditEvents);
	const params = new URLSearchParams({
		limit: "1",
		actor: "界".repeat(200),
		action: "界".repeat(200),
		resource: "界".repeat(200),
		outcome: "界".repeat(200),
		search: "界".repeat(200),
	});
	try {
		const first = await app.request(
			`http://localhost/v1/audit-events?${params}`,
		);
		expect(first.status).toBe(200);
		const body = await first.json();
		expect(body.next_cursor).toBeDefined();
		params.set("cursor", body.next_cursor);
		expect(
			(await app.request(`http://localhost/v1/audit-events?${params}`)).status,
		).toBe(200);
	} finally {
		query.mockReset();
	}
});

test("rejects malformed cursors before querying", async () => {
	query.mockImplementation(async () => ({ rows: [] }));
	const app = new OpenAPIHono();
	app.use("/v1/*", async (c, next) => {
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor: "reader",
			actorId,
			organizationId,
		});
		await next();
	});
	app.openapi(auditLogRoute, handleListAuditEvents);
	try {
		const response = await app.request(
			"http://localhost/v1/audit-events?cursor=not-a-cursor",
		);
		expect(response.status).toBe(400);
		expect(query).not.toHaveBeenCalled();
	} finally {
		query.mockReset();
	}
});
