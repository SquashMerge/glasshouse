import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";
import { resolveAuthorizedProjectScope } from "../../src/tenancy";

const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const createdAt = new Date("2026-07-15T10:00:00.000Z");
const query = mock(async (sql: string, values: string[]) => {
	if (
		sql.includes("COALESCE(pm.role, '')") ||
		sql.includes("CASE WHEN om.role = 'owner' THEN 'owner'")
	) {
		const [projectId, , actor] = values;
		return {
			rows: [
				{
					role:
						actor === "owner" &&
						sql.includes("CASE WHEN om.role = 'owner' THEN 'owner'")
							? "owner"
							: actor === "owner"
								? ""
								: actor === "manager" && projectId === PROJECT
									? "manager"
									: "",
				},
			],
		};
	}
	if (sql.includes("SELECT role FROM organization_memberships")) {
		return { rows: [{ role: values[1] === "owner" ? "owner" : "member" }] };
	}
	if (sql.startsWith("WITH p AS")) {
		return {
			rows: [
				{
					id: PROJECT,
					name: "New Project",
					slug: "new-project",
					status: "active",
					created_at: createdAt,
					archived_at: null,
				},
			],
		};
	}
	if (sql.startsWith("SELECT id, actor_subject, event_type")) {
		return {
			rows: [
				{
					id: "33333333-3333-4333-8333-333333333333",
					actor_subject: "owner",
					event_type: "project_archived",
					created_at: createdAt,
				},
			],
		};
	}
	if (sql.includes("UPDATE projects")) {
		return {
			rows: [
				{
					id: PROJECT,
					name: "Renamed",
					slug: "project",
					status: "active",
					created_at: createdAt,
					archived_at: null,
				},
			],
		};
	}
	if (sql.startsWith("WITH membership AS (INSERT INTO project_memberships"))
		return {
			rows: [
				{ actor_subject: values[2], role: values[3], created_at: createdAt },
			],
		};
	if (
		sql.startsWith("WITH membership AS (INSERT INTO organization_memberships")
	)
		return {
			rows: [
				{ actor_subject: values[1], role: values[2], created_at: createdAt },
			],
		};
	if (sql.startsWith("WITH deleted AS (DELETE")) return { rows: [{}] };
	return { rows: [], rowCount: 1 };
});

const postgres = await import("../../src/db/postgres");
mock.module("../../src/db/postgres", () => ({
	...postgres,
	pgPool: () => ({ query }),
}));

const {
	createProject,
	archiveProject,
	deleteOrganizationMember,
	deleteProjectMember,
	handleArchiveProject,
	handleCreateProject,
	handleDeleteOrganizationMember,
	handleDeleteProjectMember,
	handleGetProjectAuditEvents,
	handleGetMe,
	handleListProjectMembers,
	handleListProjects,
	handleListOrganizationMembers,
	handlePutOrganizationMember,
	handlePutProjectMember,
	handleRestoreProject,
	handleUpdateProject,
	getMe,
	listOrganizationMembers,
	listProjectMembers,
	listProjectAuditEvents,
	listProjects,
	putOrganizationMember,
	putProjectMember,
	restoreProject,
	updateProject,
} = await import("../../src/routes/projects");

const api = new OpenAPIHono({
	defaultHook: (result, c) =>
		result.success
			? undefined
			: c.json(
					{ code: "BAD_REQUEST", message: "Request validation failed" },
					400,
				),
});
api.use("/v1/*", async (c, next) => {
	const actor = c.req.header("x-test-actor");
	if (actor)
		c.set(TRUSTED_TENANT_CONTEXT_KEY, { actor, organizationId: ORGANIZATION });
	await next();
});
api.openapi(createProject, handleCreateProject);
api.openapi(getMe, handleGetMe);
api.openapi(listProjects, handleListProjects);
api.openapi(updateProject, handleUpdateProject);
api.openapi(archiveProject, handleArchiveProject);
api.openapi(restoreProject, handleRestoreProject);
api.openapi(putProjectMember, handlePutProjectMember);
api.openapi(deleteProjectMember, handleDeleteProjectMember);
api.openapi(putOrganizationMember, handlePutOrganizationMember);
api.openapi(listOrganizationMembers, handleListOrganizationMembers);
api.openapi(listProjectMembers, handleListProjectMembers);
api.openapi(deleteOrganizationMember, handleDeleteOrganizationMember);
api.openapi(listProjectAuditEvents, handleGetProjectAuditEvents);

function request(actor: string, path: string, init?: RequestInit) {
	return api.request(`http://localhost${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			"x-test-actor": actor,
			...init?.headers,
		},
	});
}

beforeEach(() => query.mockClear());

describe("project authorization routes", () => {
	it("rejects members from creating projects or changing organization roles", async () => {
		const create = await request("member", "/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "New Project", slug: "new-project" }),
		});
		const promote = await request("member", "/v1/organization/members/member", {
			method: "PUT",
			body: JSON.stringify({ actor_subject: "member", role: "owner" }),
		});

		expect(create.status).toBe(403);
		expect(promote.status).toBe(403);
		expect(await create.json()).toEqual({
			code: "FORBIDDEN",
			message: "Forbidden",
		});
		expect(await promote.json()).toEqual({
			code: "FORBIDDEN",
			message: "Forbidden",
		});
		expect(query.mock.calls.some(([sql]) => sql.startsWith("WITH p AS"))).toBe(
			false,
		);
		expect(
			query.mock.calls.some(([sql]) =>
				sql.startsWith("INSERT INTO organization_memberships"),
			),
		).toBe(false);
	});

	it("allows an owner without a project membership to manage a project", async () => {
		const update = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "PATCH",
			body: JSON.stringify({ name: "Renamed" }),
		});
		const member = await request(
			"owner",
			`/v1/projects/${PROJECT}/members/member`,
			{
				method: "PUT",
				body: JSON.stringify({ actor_subject: "member", role: "member" }),
			},
		);

		expect(update.status).toBe(200);
		expect(member.status).toBe(200);
	});

	it("updates a project's name and slug without changing its stable id", async () => {
		const response = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "PATCH",
			body: JSON.stringify({ name: "Renamed", slug: "renamed-project" }),
		});

		expect(response.status).toBe(200);
		expect((await response.json()).id).toBe(PROJECT);
		expect(
			query.mock.calls.some(
				([sql, values]) =>
					sql.includes("SET name = COALESCE") &&
					values.includes("renamed-project") &&
					sql.includes("'project_updated'"),
			),
		).toBe(true);
	});

	it("lists actor roles and archived projects only in management mode", async () => {
		query.mockImplementationOnce(async () => ({
			rows: [{ role: "member" }],
		}));
		query.mockImplementationOnce(async (sql: string) => {
			expect(sql).toContain("p.status = 'active'");
			expect(sql).toContain("project_role");
			return {
				rows: [
					{
						id: PROJECT,
						name: "Project One",
						slug: "project-one",
						status: "active",
						created_at: createdAt,
						archived_at: null,
						project_role: "member",
					},
				],
			};
		});
		const active = await request("member", "/v1/projects");

		expect(active.status).toBe(200);
		expect((await active.json()).items[0].project_role).toBe("member");

		query.mockImplementationOnce(async () => ({
			rows: [{ role: "member" }],
		}));
		query.mockImplementationOnce(async (sql: string) => {
			expect(sql).toContain("$3::boolean");
			expect(sql).toContain("IN ('manager', 'owner')");
			return { rows: [] };
		});
		const management = await request(
			"member",
			"/v1/projects?include_archived=true",
		);

		expect(management.status).toBe(200);
		expect((await management.json()).items).toHaveLength(0);
	});

	it("keeps /v1/me active-only while exposing the actor project role", async () => {
		query.mockImplementationOnce(async () => ({ rows: [{ role: "member" }] }));
		query.mockImplementationOnce(async (sql: string) => {
			expect(sql).toContain("p.status = 'active'");
			return {
				rows: [
					{
						id: PROJECT,
						name: "Project One",
						slug: "project-one",
						status: "active",
						created_at: createdAt,
						archived_at: null,
						project_role: "member",
					},
				],
			};
		});
		const response = await request("member", "/v1/me");

		expect(response.status).toBe(200);
		expect((await response.json()).projects).toEqual([
			expect.objectContaining({ id: PROJECT, project_role: "member" }),
		]);
	});

	it("rejects invalid archived management mode values", async () => {
		const response = await request(
			"owner",
			"/v1/projects?include_archived=yes",
		);
		expect(response.status).toBe(400);
	});

	it("rejects empty and invalid project metadata updates", async () => {
		const empty = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "PATCH",
			body: JSON.stringify({}),
		});
		const invalidSlug = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "PATCH",
			body: JSON.stringify({ slug: "Invalid slug" }),
		});

		expect(empty.status).toBe(400);
		expect(invalidSlug.status).toBe(400);
	});

	it("maps a same-organization slug collision to a safe conflict", async () => {
		query.mockImplementationOnce(async () => ({
			rows: [{ role: "owner" }],
		}));
		query.mockImplementationOnce(async () => {
			throw Object.assign(new Error("duplicate key"), { code: "23505" });
		});
		const response = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "PATCH",
			body: JSON.stringify({ slug: "taken" }),
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			code: "CONFLICT",
			message: "Project slug is already in use",
		});
	});

	it("supports archive, restore, member upsert/delete, and manager audit reads", async () => {
		const members = await request("manager", `/v1/projects/${PROJECT}/members`);
		const archive = await request(
			"manager",
			`/v1/projects/${PROJECT}/archive`,
			{
				method: "POST",
			},
		);
		const restore = await request(
			"manager",
			`/v1/projects/${PROJECT}/restore`,
			{
				method: "POST",
			},
		);
		const upsert = await request(
			"manager",
			`/v1/projects/${PROJECT}/members/member`,
			{
				method: "PUT",
				body: JSON.stringify({ actor_subject: "member", role: "member" }),
			},
		);
		const remove = await request(
			"manager",
			`/v1/projects/${PROJECT}/members/member`,
			{
				method: "DELETE",
			},
		);
		const audit = await request(
			"manager",
			`/v1/projects/${PROJECT}/audit-events`,
		);
		const ownerAudit = await request(
			"owner",
			`/v1/projects/${PROJECT}/audit-events`,
		);

		for (const response of [
			members,
			archive,
			restore,
			upsert,
			remove,
			audit,
			ownerAudit,
		])
			expect(response.ok).toBe(true);
		expect((await audit.json()).items).toEqual([
			{
				id: "33333333-3333-4333-8333-333333333333",
				actor_subject: "owner",
				event_type: "project_archived",
				created_at: createdAt.toISOString(),
			},
		]);
	});

	it("writes each authorization mutation and its audit event in one statement", async () => {
		await request("manager", `/v1/projects/${PROJECT}/archive`, {
			method: "POST",
		});
		await request("manager", `/v1/projects/${PROJECT}/restore`, {
			method: "POST",
		});
		await request("manager", `/v1/projects/${PROJECT}/members/member`, {
			method: "PUT",
			body: JSON.stringify({ actor_subject: "member", role: "member" }),
		});
		await request("manager", `/v1/projects/${PROJECT}/members/member`, {
			method: "DELETE",
		});
		await request("owner", "/v1/organization/members/member", {
			method: "PUT",
			body: JSON.stringify({ actor_subject: "member", role: "member" }),
		});
		await request("owner", "/v1/organization/members/member", {
			method: "DELETE",
		});

		const mutations = query.mock.calls
			.map(([sql]) => sql)
			.filter((sql) => sql.startsWith("WITH "));
		expect(mutations).toHaveLength(6);
		for (const sql of mutations) {
			expect(sql).toContain(
				"audit AS (INSERT INTO project_authorization_audit_events",
			);
			expect(sql).toContain("SELECT * FROM");
		}
	});

	it("terminalizes archive-time work in the archive transaction so restore cannot recover it", async () => {
		await request("manager", `/v1/projects/${PROJECT}/archive`, {
			method: "POST",
		});

		const archiveSql = query.mock.calls.find(
			([sql]) =>
				sql.includes("project_work_cancelled") &&
				sql.includes("cancelled_experiments"),
		)?.[0];
		expect(archiveSql).toContain("e.status IN ('pending', 'running')");
		expect(archiveSql).toContain("t.status IN ('pending', 'running')");
		expect(archiveSql).toContain(
			"j.status IN ('queued', 'preparing', 'optimizing', 'evaluating')",
		);
		expect(archiveSql).toContain("INSERT INTO prompt_optimization_events");
	});

	it("keeps lifecycle, membership, and audit data non-enumerable across projects", async () => {
		const archive = await request(
			"manager",
			`/v1/projects/${OTHER_PROJECT}/archive`,
			{
				method: "POST",
			},
		);
		const remove = await request(
			"manager",
			`/v1/projects/${OTHER_PROJECT}/members/member`,
			{ method: "DELETE" },
		);
		const audit = await request(
			"manager",
			`/v1/projects/${OTHER_PROJECT}/audit-events`,
		);

		for (const response of [archive, remove, audit]) {
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				code: "NOT_FOUND",
				message: "Project is not available",
			});
		}
	});

	it("allows owners to list and remove organization members and audits the removal", async () => {
		const list = await request("owner", "/v1/organization/members");
		const remove = await request("owner", "/v1/organization/members/member", {
			method: "DELETE",
		});

		expect(list.status).toBe(200);
		expect(remove.status).toBe(204);
		expect(
			query.mock.calls.some(([sql]) =>
				sql.includes("'organization_membership_removed'"),
			),
		).toBe(true);
	});

	it("does not reveal another project to a manager", async () => {
		const response = await request("manager", `/v1/projects/${OTHER_PROJECT}`, {
			method: "PATCH",
			body: JSON.stringify({ name: "Renamed" }),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			code: "NOT_FOUND",
			message: "Project is not available",
		});
	});

	it("grants an owner project scope without a project membership", async () => {
		const scopeQuery = mock(async (sql: string) => {
			expect(sql).toContain("CASE WHEN om.role = 'owner' THEN 'manager'");
			return {
				rows: [
					{
						organization_role: "owner" as const,
						project_role: "manager" as const,
						status: "active" as const,
					},
				],
			};
		});

		const scope = await resolveAuthorizedProjectScope(
			{ query: scopeQuery } as never,
			{ actor: "owner", organizationId: ORGANIZATION },
			PROJECT,
		);

		expect(scope.projectRole).toBe("manager");
	});

	it("does not grant an organization member scope for a project without membership", async () => {
		const scopeQuery = mock(async (sql: string) => {
			expect(sql).toContain("pm.actor_subject IS NOT NULL");
			return { rows: [] };
		});

		await expect(
			resolveAuthorizedProjectScope(
				{ query: scopeQuery } as never,
				{ actor: "member", organizationId: ORGANIZATION },
				OTHER_PROJECT,
			),
		).rejects.toThrow("Project is not available");
	});
});
