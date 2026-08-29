import { afterAll, expect, mock, test } from "bun:test";

const USER = "project-admin";
const PASSWORD = "secret";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const MEMBER = "member";
const AUTHORIZATION = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
const createdAt = new Date("2026-08-29T00:00:00.000Z");

const originalUsername = process.env.UI_USERNAME;
const originalPassword = process.env.UI_PASSWORD;
const originalCredentials = process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS;
process.env.UI_USERNAME = USER;
process.env.UI_PASSWORD = PASSWORD;
delete process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS;

const query = mock(async (sql: string, values: unknown[] = []) => {
	if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
	if (sql.startsWith("SELECT decision.effective_role"))
		return {
			rows: [
				{
					effective_role: "admin",
					enforcement: "compatibility",
					project_status: "active",
					allowed: true,
				},
			],
		};
	if (sql.startsWith("SELECT authorization_allows_organization"))
		return { rows: [{ allowed: true }] };
	if (sql.startsWith("SELECT authorization_allows_project"))
		return { rows: [{ allowed: true }] };
	if (sql.startsWith("SELECT pm.actor_subject, pm.role"))
		return {
			rows: [{ actor_subject: MEMBER, role: "member", created_at: createdAt }],
		};
	if (sql.startsWith("SELECT om.actor_subject, om.role"))
		return {
			rows: [{ actor_subject: MEMBER, role: "member", created_at: createdAt }],
		};
	if (
		sql.startsWith("SELECT p.id FROM projects p") &&
		sql.includes("p.status = ANY")
	)
		return { rows: [{ id: PROJECT }] };
	if (sql.startsWith("SELECT id FROM projects WHERE organization_id"))
		return { rows: [{ id: PROJECT }] };
	if (sql.startsWith("SELECT lock_project_audit_provenance"))
		return { rows: [] };
	if (
		sql.startsWith("SELECT om.actor_subject FROM") ||
		sql.startsWith("SELECT pm.actor_subject FROM") ||
		sql.startsWith("SELECT actor_subject FROM organization_memberships") ||
		sql.startsWith("SELECT actor_id FROM organization_actor_roles") ||
		sql.startsWith("SELECT actor_id FROM project_actor_grants")
	)
		return { rows: [] };
	if (sql.includes("INSERT INTO project_memberships"))
		return {
			rows: [
				{
					actor_subject: values[2],
					role: values[3],
					created_at: createdAt,
				},
			],
		};
	if (sql.includes("DELETE FROM project_memberships")) return { rows: [{}] };
	if (sql.includes("INSERT INTO organization_memberships"))
		return {
			rows: [
				{
					actor_subject: values[1],
					role: values[2],
					created_at: createdAt,
				},
			],
		};
	if (sql.includes("DELETE FROM organization_memberships"))
		return { rows: [{ actor_subject: values[1] }] };
	throw new Error(`Unexpected SQL in production route regression: ${sql}`);
});
const pool = {
	query,
	connect: async () => ({ query, release() {} }),
};
const postgres = await import("../../src/db/postgres");
mock.module("../../src/db/postgres", () => ({
	...postgres,
	pgPool: () => pool,
}));

const { createApiApp } = await import("../../src/index");

afterAll(() => {
	if (originalUsername === undefined) delete process.env.UI_USERNAME;
	else process.env.UI_USERNAME = originalUsername;
	if (originalPassword === undefined) delete process.env.UI_PASSWORD;
	else process.env.UI_PASSWORD = originalPassword;
	if (originalCredentials === undefined)
		delete process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS;
	else process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS = originalCredentials;
});

test("production app serves the legacy project and organization member routes", async () => {
	const app = createApiApp();
	const request = (path: string, init: RequestInit = {}) =>
		app.request(`http://localhost${path}`, {
			...init,
			headers: {
				authorization: AUTHORIZATION,
				...init.headers,
			},
		});
	const statuses: Record<string, number> = {};
	const record = async (contract: string, response: Promise<Response>) => {
		statuses[contract] = (await response).status;
	};

	await record(
		"GET project members",
		request(`/v1/projects/${PROJECT}/members`),
	);
	await record(
		"PUT project member",
		request(`/v1/projects/${PROJECT}/members/${MEMBER}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ actor_subject: MEMBER, role: "read_only" }),
		}),
	);
	await record(
		"DELETE project member",
		request(`/v1/projects/${PROJECT}/members/${MEMBER}`, {
			method: "DELETE",
		}),
	);
	await record(
		"PUT organization member",
		request(`/v1/organization/members/${MEMBER}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ actor_subject: MEMBER, role: "user" }),
		}),
	);
	await record("GET organization members", request("/v1/organization/members"));
	await record(
		"DELETE organization member",
		request(`/v1/organization/members/${MEMBER}`, { method: "DELETE" }),
	);

	expect(statuses).toEqual({
		"GET project members": 200,
		"PUT project member": 200,
		"DELETE project member": 204,
		"PUT organization member": 200,
		"GET organization members": 200,
		"DELETE organization member": 204,
	});
});
