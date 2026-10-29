import { afterEach, expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const PROJECT = "00000000-0000-4000-8000-000000000011";
const ACTOR = "00000000-0000-4000-8000-000000000013";
const ID = "00000000-0000-4000-8000-000000000012";
let adminAllowed = true;
const actions: string[] = [];
const query = mock(async (sql: string, values: unknown[] = []) => {
	if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
	if (sql.startsWith("SELECT id FROM projects"))
		return {
			rows:
				values[0] === PROJECT && values[1] === ORGANIZATION
					? [{ id: PROJECT }]
					: [],
		};
	if (sql.includes("INSERT INTO project_otlp_credentials"))
		return {
			rows: [
				{
					id: ID,
					organization_id: values[0],
					project_id: values[1],
					name: values[2],
					secret_prefix: values[4],
					created_by_actor_id: values[5],
					created_at: new Date("2026-10-01T00:00:00Z"),
					rotated_at: null,
					revoked_at: null,
					last_used_at: null,
				},
			],
		};
	if (sql.includes("SELECT audit_admin_access_event")) {
		actions.push(String(values[3]));
		return { rows: [] };
	}
	if (
		sql.startsWith(
			"SELECT id, organization_id, project_id, name, secret_prefix",
		)
	)
		return {
			rows: [
				{
					id: ID,
					organization_id: ORGANIZATION,
					project_id: PROJECT,
					name: "payments",
					secret_prefix: "gh_ing_abcdefgh",
					created_by_actor_id: ACTOR,
					created_at: new Date("2026-10-01T00:00:00Z"),
					rotated_at: null,
					revoked_at: null,
					last_used_at: null,
				},
			],
		};
	if (sql.startsWith("UPDATE project_otlp_credentials SET secret_digest"))
		return {
			rows: [
				{
					id: ID,
					organization_id: ORGANIZATION,
					project_id: PROJECT,
					name: "payments",
					secret_prefix: values[4],
					created_by_actor_id: ACTOR,
					created_at: new Date("2026-10-01T00:00:00Z"),
					rotated_at: new Date("2026-10-02T00:00:00Z"),
					revoked_at: null,
					last_used_at: null,
				},
			],
		};
	if (sql.startsWith("UPDATE project_otlp_credentials SET revoked_at"))
		return {
			rows: [
				{
					id: ID,
					organization_id: ORGANIZATION,
					project_id: PROJECT,
					name: "payments",
					secret_prefix: "gh_ing_abcdefgh",
					created_by_actor_id: ACTOR,
					created_at: new Date("2026-10-01T00:00:00Z"),
					rotated_at: null,
					revoked_at: new Date("2026-10-02T00:00:00Z"),
					last_used_at: null,
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
const projectAuthorization = await import("../../src/db/project-authorization");
mock.module("../../src/db/project-authorization", () => ({
	...projectAuthorization,
	lockAuthorizedOrganization: async () => adminAllowed,
}));
const routes = await import("../../src/routes/otlp-credentials");

afterEach(() => {
	query.mockClear();
	actions.length = 0;
	adminAllowed = true;
});

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
			actor: "admin",
			actorId: ACTOR,
			organizationId: ORGANIZATION,
		});
		await next();
	});
	api.openapi(routes.listOtlpCredentials, routes.handleListOtlpCredentials);
	api.openapi(routes.createOtlpCredential, routes.handleCreateOtlpCredential);
	api.openapi(routes.rotateOtlpCredential, routes.handleRotateOtlpCredential);
	api.openapi(routes.revokeOtlpCredential, routes.handleRevokeOtlpCredential);
	return api;
}

test("Admin can create, list, rotate, and revoke a project-bound OTLP credential with safe audit actions", async () => {
	const api = app();
	const created = await api.request("/v1/admin/otlp-credentials", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ project_id: PROJECT, name: " payments " }),
	});
	const createdBody = (await created.json()) as {
		credential: { name: string };
		secret: string;
	};
	expect(created.status).toBe(201);
	expect(createdBody.credential.name).toBe("payments");
	expect("organization_id" in createdBody.credential).toBe(false);
	expect(createdBody.secret).toMatch(/^gh_ing_[A-Za-z0-9_-]{43}$/);
	const createdSql = query.mock.calls.find(([sql]) =>
		String(sql).includes("INSERT INTO project_otlp_credentials"),
	);
	expect(createdSql?.[1]).not.toContain(createdBody.secret);

	const listed = await api.request(
		`/v1/admin/otlp-credentials?project_id=${PROJECT}`,
	);
	expect(listed.status).toBe(200);
	expect(await listed.text()).not.toContain(createdBody.secret);

	const rotated = await api.request(
		`/v1/admin/otlp-credentials/${ID}/rotate?project_id=${PROJECT}`,
		{ method: "POST" },
	);
	expect(rotated.status).toBe(200);
	expect(await rotated.json()).toMatchObject({
		credential: { id: ID },
		secret: expect.stringMatching(/^gh_ing_[A-Za-z0-9_-]{43}$/),
	});

	const revoked = await api.request(
		`/v1/admin/otlp-credentials/${ID}/revoke?project_id=${PROJECT}`,
		{ method: "POST" },
	);
	expect(revoked.status).toBe(200);
	expect(actions).toEqual([
		"project_otlp_credential_created",
		"project_otlp_credential_rotated",
		"project_otlp_credential_revoked",
	]);
});

test("non-Admins and Projects outside the authenticated organization cannot manage credentials", async () => {
	const api = app();
	adminAllowed = false;
	const denied = await api.request(
		`/v1/admin/otlp-credentials?project_id=${PROJECT}`,
	);
	expect(denied.status).toBe(403);
	expect(
		query.mock.calls.some(([sql]) =>
			String(sql).startsWith("SELECT id FROM projects"),
		),
	).toBe(false);

	adminAllowed = true;
	const foreign = await api.request("/v1/admin/otlp-credentials", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			project_id: "22222222-2222-4222-8222-222222222222",
			name: "foreign",
		}),
	});
	expect(foreign.status).toBe(404);
	expect(
		query.mock.calls.some(([sql]) =>
			String(sql).includes("INSERT INTO project_otlp_credentials"),
		),
	).toBe(false);
	expect(actions).toHaveLength(0);
});
