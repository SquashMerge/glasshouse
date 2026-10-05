import { expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";

const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const OWNER = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const createdAt = new Date("2026-08-13T00:00:00.000Z");

const query = mock(async (sql: string, values: unknown[] = []) => {
	if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
	if (sql.startsWith("SELECT authorization_allows_organization"))
		return { rows: [{ allowed: true }] };
	if (sql.startsWith("SELECT actor_id FROM organization_actor_roles"))
		return { rows: [] };
	if (sql.startsWith("SELECT 1 FROM actor_identities")) return { rows: [{}] };
	if (sql.startsWith("SELECT project_id FROM project_actor_grants"))
		return { rows: [] };
	if (sql.includes("FROM organization_actor_roles"))
		return {
			rows: [
				{ actor_id: OWNER, organization_role: "admin", created_at: createdAt },
				{
					actor_id: USER,
					organization_role: "read_only",
					created_at: createdAt,
				},
			],
		};
	if (
		sql.includes("FROM actor_identities identity LEFT JOIN") &&
		sql.includes("AS username")
	) {
		const actors = [
			{
				actor_id: OWNER,
				username: "owner",
				organization_role: "admin",
				created_at: createdAt,
			},
			{
				actor_id: USER,
				username: "reader",
				organization_role: "read_only",
				created_at: createdAt,
			},
		];
		return {
			rows:
				values.length > 1
					? actors.filter((actor) => actor.actor_id === values[1])
					: actors,
		};
	}
	if (sql.includes("FROM actor_identities identity LEFT JOIN"))
		return {
			rows: [
				{ actor_id: OWNER, organization_role: "admin", created_at: createdAt },
				{
					actor_id: USER,
					organization_role: "read_only",
					created_at: createdAt,
				},
			],
		};
	if (sql.includes("FROM actor_identities"))
		return { rows: [{ canonical_subject: "reader" }] };
	if (sql.includes("INSERT INTO organization_actor_roles"))
		return {
			rows: [
				{
					actor_id: values[1],
					organization_role: values[2],
					created_at: createdAt,
				},
			],
		};
	return { rows: [] };
});

const postgres = await import("../../src/db/postgres");
mock.module("../../src/db/postgres", () => ({
	...postgres,
	pgPool: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));

const {
	listAdminActors,
	setAdminActorRole,
	handleListAdminActors,
	handleSetAdminActorRole,
} = await import("../../src/routes/admin-access");

function app() {
	const api = new OpenAPIHono({
		defaultHook: (result, c) =>
			result.success
				? undefined
				: c.json(
						{ code: "BAD_REQUEST", message: "Request validation failed" },
						400,
					),
	});
	api.use("*", async (c, next) => {
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor: "owner",
			actorId: OWNER,
			organizationId: ORGANIZATION,
		});
		await next();
	});
	api.openapi(listAdminActors, handleListAdminActors);
	api.openapi(setAdminActorRole, handleSetAdminActorRole);
	return api;
}

test("Access lists human usernames and excludes internal worker identities", async () => {
	const api = app();
	const listed = await api.request("/v1/admin/actors");
	const updated = await api.request(`/v1/admin/actors/${USER}/role`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ role: "read_only" }),
	});

	expect(listed.status).toBe(200);
	expect(await listed.json()).toEqual({
		items: [
			{
				actor_id: OWNER,
				username: "owner",
				organization_role: "admin",
				created_at: createdAt.toISOString(),
			},
			{
				actor_id: USER,
				username: "reader",
				organization_role: "read_only",
				created_at: createdAt.toISOString(),
			},
		],
	});
	expect(
		query.mock.calls.some(([sql]) =>
			String(sql).includes("internal:evaluation-worker:v1"),
		),
	).toBe(true);
	expect(updated.status).toBe(200);
	expect(await updated.json()).toMatchObject({
		actor_id: USER,
		username: "reader",
		organization_role: "read_only",
	});
	const identityFilter = query.mock.calls
		.map(([sql]) => String(sql))
		.find(
			(sql) =>
				sql.includes("FROM actor_identities identity") &&
				sql.includes("internal:evaluation-worker:v1"),
		);
	expect(identityFilter).toContain(
		"identity.canonical_subject = identity.organization_id::text",
	);
	expect(identityFilter).toContain("durable_actor_id");
	expect(
		query.mock.calls.some(([sql]) =>
			String(sql).includes("audit_admin_access_event"),
		),
	).toBe(true);
});
