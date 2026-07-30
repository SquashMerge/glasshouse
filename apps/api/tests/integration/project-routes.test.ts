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
	if (sql.startsWith("UPDATE projects")) {
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
	if (sql.startsWith("INSERT INTO project_memberships"))
		return {
			rows: [
				{ actor_subject: values[2], role: values[3], created_at: createdAt },
			],
		};
	if (sql.startsWith("INSERT INTO organization_memberships"))
		return { rows: [{ actor_subject: values[1], role: values[2] }] };
	return { rows: [], rowCount: 1 };
});

const postgres = await import("../../src/db/postgres");
mock.module("../../src/db/postgres", () => ({
	...postgres,
	pgPool: () => ({ query }),
}));

const {
	createProject,
	handleCreateProject,
	handlePutOrganizationMember,
	handlePutProjectMember,
	handleUpdateProject,
	putOrganizationMember,
	putProjectMember,
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
api.openapi(updateProject, handleUpdateProject);
api.openapi(putProjectMember, handlePutProjectMember);
api.openapi(putOrganizationMember, handlePutOrganizationMember);

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
});
