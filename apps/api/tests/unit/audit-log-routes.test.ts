import { expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";

const organizationId = "00000000-0000-4000-8000-000000000001";
const actorId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const createdAt = "2026-11-01T12:00:00.123456Z";
const statements: Array<{ sql: string; values?: unknown[] }> = [];
let snapshot: { entries: unknown[]; signing_key: Buffer } | undefined;
const rows = [eventId, "22222222-2222-4222-8222-222222222223"].map((id) => ({
	id,
	source: "project_authorization",
	project_id: projectId,
	actor: "alice",
	action: "project_updated",
	resource_type: "project",
	resource_id: projectId,
	outcome: null,
	created_at: createdAt,
}));
const query = mock(async (sql: string, values?: unknown[]) => {
	statements.push({ sql, values });
	if (sql.includes("SELECT actor_id FROM organization_actor_roles"))
		return { rows: [{ actor_id: actorId }], rowCount: 1 };
	if (sql.includes("SELECT id FROM projects WHERE"))
		return { rows: [{ id: projectId }], rowCount: 1 };
	if (sql.includes("WITH audit_events AS"))
		return { rows, rowCount: rows.length };
	if (sql.includes("count(*)::int AS total"))
		return { rows: [{ total: 0, org: 0, actor: 0 }], rowCount: 1 };
	if (sql.startsWith("INSERT INTO audit_log_snapshots")) {
		snapshot = {
			signing_key: values![4] as Buffer,
			entries: JSON.parse(values![5] as string),
		};
	}
	if (sql.includes("FROM audit_log_snapshots WHERE id = $1"))
		return {
			rows: snapshot ? [{ ...snapshot, authorized: true }] : [],
			rowCount: snapshot ? 1 : 0,
		};
	return { rows: [], rowCount: 0 };
});
const postgres = await import("../../src/db/postgres.js");
const { TRUSTED_TENANT_CONTEXT_KEY } = await import(
	"../../src/middleware/auth.js"
);
mock.module("../../src/db/postgres.js", () => ({
	...postgres,
	pgPool: () => ({ connect: async () => ({ query, release: () => {} }) }),
}));
const { auditLogRoute, handleListAuditEvents } = await import(
	"../../src/routes/audit-log.js"
);
function app() {
	const instance = new OpenAPIHono({
		defaultHook: (result, c) =>
			result.success
				? undefined
				: c.json(
						{ code: "BAD_REQUEST", message: "Request validation failed" },
						400,
					),
	});
	instance.use("/v1/*", async (c, next) => {
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor: "reader",
			actorId,
			organizationId,
		});
		await next();
	});
	instance.openapi(auditLogRoute, handleListAuditEvents);
	return instance;
}

test("lists audit-safe entries using scoped projection and snapshot cursor", async () => {
	statements.length = 0;
	snapshot = undefined;
	const response = await app().request(
		"http://localhost/v1/audit-events?limit=1&actor=alice&action=project_updated&resource=project&outcome=success&search=alice",
	);
	expect(response.status).toBe(200);
	const body = await response.json();
	const projection = statements.find((statement) =>
		statement.sql.includes("WITH audit_events AS"),
	)!;
	expect(projection.sql).toContain("authorization_allows_project");
	expect(projection.sql).toContain("'audit_read'");
	expect(projection.sql).toContain(
		"e.created_at DESC, e.event_id DESC, e.source DESC",
	);
	expect(projection.sql).toContain("ILIKE");
	expect(projection.values).toContain(organizationId);
	expect(projection.values).toContainEqual([projectId]);
	expect(body.items).toEqual([
		{
			id: eventId,
			source: "project_authorization",
			actor: "alice",
			action: "project_updated",
			resource_type: "project",
			resource_id: projectId,
			outcome: null,
			created_at: createdAt,
			details: { source: "project_authorization" },
		},
	]);
	expect(body.next_cursor).toMatch(/^v1\./);
});

test("continuation accepts its own cursor with maximum-length Unicode filters", async () => {
	snapshot = undefined;
	const application = app();
	const params = new URLSearchParams({
		limit: "1",
		actor: "界".repeat(200),
		action: "界".repeat(200),
		resource: "界".repeat(200),
		outcome: "界".repeat(200),
		search: "界".repeat(200),
	});
	const first = await application.request(
		`http://localhost/v1/audit-events?${params}`,
	);
	expect(first.status).toBe(200);
	params.set("cursor", (await first.json()).next_cursor);
	const second = await application.request(
		`http://localhost/v1/audit-events?${params}`,
	);
	expect(second.status).toBe(200);
	expect((await second.json()).items[0].id).toBe(rows[1]!.id);
});

test("rejects malformed cursors before querying", async () => {
	query.mockClear();
	const response = await app().request(
		"http://localhost/v1/audit-events?cursor=not-a-cursor",
	);
	expect(response.status).toBe(400);
	expect(query).not.toHaveBeenCalled();
});
