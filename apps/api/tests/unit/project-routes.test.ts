import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";
import { resolveAuthorizedProjectScope } from "../../src/tenancy";
import { logger } from "../../src/lib/logger";

const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const createdAt = new Date("2026-07-15T10:00:00.000Z");
const actorIds = {
	owner: "33333333-3333-4333-8333-333333333333",
	manager: "44444444-4444-4444-8444-444444444444",
	member: "55555555-5555-4555-8555-555555555555",
	"cross-org-manager": "66666666-6666-4666-8666-666666666666",
} as const;
const defaultQuery = async (sql: string, values: string[] = []) => {
	if (sql.startsWith("SELECT decision.effective_role")) {
		const [, projectId, actorId, operation] = values;
		const role =
			actorId === actorIds.owner
				? "admin"
				: actorId === actorIds.manager
					? "user"
					: actorId === actorIds.member
						? "read_only"
						: null;
		const allowed =
			projectId === PROJECT &&
			(role === "admin" ||
				(role === "user" &&
					[
						"product_read",
						"product_write",
						"execute",
						"ingest",
						"audit_read",
						"project_manage",
						"governed",
					].includes(operation!)) ||
				(role === "read_only" &&
					["product_read", "product_write", "execute", "ingest"].includes(
						operation!,
					)));
		return {
			rows: [
				{
					effective_role: role,
					enforcement: "compatibility",
					project_status: "active",
					allowed,
				},
			],
		};
	}
	if (sql.startsWith("SELECT authorization_allows_organization"))
		return { rows: [{ allowed: values[1] === actorIds.owner }] };
	if (sql.startsWith("SELECT id FROM organizations WHERE id = $1 FOR UPDATE"))
		return { rows: [{ id: values[0] }] };
	if (sql.includes("p.status = ANY($3::text[])")) {
		const [projectId] = values;
		return projectId === OTHER_PROJECT
			? { rows: [] }
			: { rows: [{ id: projectId }] };
	}
	if (sql.startsWith("SELECT om.actor_subject FROM organization_memberships"))
		return { rows: [{ actor_subject: "manager" }] };
	if (sql.startsWith("SELECT pm.actor_subject FROM project_memberships"))
		return { rows: [{ actor_subject: "manager" }] };
	if (sql.startsWith("SELECT authorization_allows_project")) {
		const [, projectId, actorId] = values;
		return {
			rows: [
				{
					allowed:
						projectId !== OTHER_PROJECT &&
						(actorId === actorIds.owner || actorId === actorIds.manager),
				},
			],
		};
	}
	if (sql.startsWith("SELECT actor_subject FROM organization_memberships"))
		return { rows: [{ actor_subject: "owner" }] };
	if (sql.startsWith("SELECT id FROM projects WHERE organization_id"))
		return { rows: [{ id: PROJECT }] };
	if (sql.startsWith("SELECT id FROM projects WHERE id = $1"))
		return { rows: [{ id: values[0] }] };
	if (sql.startsWith("SELECT p.name, p.status FROM projects"))
		return { rows: [{ name: "Project One", status: "active" }] };
	if (sql.startsWith("SELECT default_project_id FROM organizations"))
		return { rows: [{ default_project_id: OTHER_PROJECT }] };
	if (sql.startsWith("INSERT INTO project_deletion_jobs"))
		return {
			rows: [
				{
					status: "pending",
					traces_cleaned_at: null,
					observations_cleaned_at: null,
					completed_at: null,
					attempt_count: 1,
				},
			],
		};
	if (values.includes(OTHER_PROJECT)) return { rows: [] };
	if (
		sql.startsWith("WITH authz AS MATERIALIZED") ||
		sql.startsWith("WITH authorized_actor AS MATERIALIZED") ||
		sql.startsWith("WITH provenance AS MATERIALIZED")
	) {
		if (sql.includes("INSERT INTO projects") && values.includes("member"))
			return { rows: [] };
		if (
			sql.includes("INSERT INTO organization_memberships") &&
			values.at(-2) === "member"
		)
			return { rows: [] };
		if (values.includes(OTHER_PROJECT)) return { rows: [] };
		if (sql.includes("UPDATE projects"))
			return {
				rows: [
					{
						id: PROJECT,
						name: "Renamed",
						slug: "project",
						status: "active",
						created_at: createdAt,
						archived_at: null,
						project_role: "owner",
					},
				],
			};
		if (sql.includes("UPDATE organizations"))
			return {
				rows: [
					{
						id: PROJECT,
						name: "Project One",
						slug: "project-one",
						status: "active",
						created_at: createdAt,
						archived_at: null,
						is_default: true,
						project_role: "owner",
					},
				],
			};
		if (sql.includes("INSERT INTO projects"))
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
		if (sql.includes("INSERT INTO project_memberships"))
			return {
				rows: [
					{ actor_subject: values[2], role: values[3], created_at: createdAt },
				],
			};
		if (sql.includes("INSERT INTO organization_memberships"))
			return {
				rows: [
					{ actor_subject: values[1], role: values[2], created_at: createdAt },
				],
			};
		if (sql.includes("DELETE FROM")) return { rows: [{}] };
	}
	if (
		sql.startsWith("SELECT e.id, e.actor_subject") &&
		values.includes(OTHER_PROJECT)
	)
		return { rows: [] };
	if (sql.startsWith("SELECT access.effective_role AS project_role")) {
		const [projectId, actorId] = values;
		if (projectId === OTHER_PROJECT) return { rows: [] };
		return {
			rows: [
				{
					project_role:
						actorId === actorIds.owner
							? "admin"
							: actorId === actorIds.manager
								? "user"
								: "read_only",
				},
			],
		};
	}
	if (
		sql.includes("COALESCE(pm.role, '')") ||
		sql.includes("CASE WHEN om.role = 'owner' THEN 'owner'")
	) {
		const [projectId, , actorId] = values;
		const actor =
			actorId === actorIds.owner
				? "owner"
				: actorId === actorIds.manager
					? "manager"
					: actorId === actorIds.member
						? "member"
						: actorId;
		if (projectId === OTHER_PROJECT)
			return { rows: sql.includes("FOR UPDATE OF p") ? [] : [{ role: "" }] };
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
	if (sql.startsWith("SELECT e.id, e.actor_subject, e.event_type")) {
		if (values.includes(OTHER_PROJECT)) return { rows: [] };
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
};
const query = mock(defaultQuery);

const postgres = await import("../../src/db/postgres");
mock.module("../../src/db/postgres", () => ({
	...postgres,
	pgPool: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));
const clickhouse = await import("../../src/db/clickhouse");
const command = mock(async () => undefined);
mock.module("../../src/db/clickhouse", () => ({
	...clickhouse,
	ch: () => ({ command }),
}));

const {
	createProject,
	archiveProject,
	deleteOrganizationMember,
	deleteProject,
	getProject,
	getProjectDeletionStatus,
	deleteProjectMember,
	handleArchiveProject,
	handleCreateProject,
	handleDeleteOrganizationMember,
	handleDeleteProject,
	handleGetProjectDeletionStatus,
	handleDeleteProjectMember,
	handleGetProjectAuditEvents,
	handleGetMe,
	handleGetProject,
	handleListProjectMembers,
	handleListProjects,
	handleListOrganizationMembers,
	handlePutOrganizationMember,
	handlePutProjectMember,
	handleRestoreProject,
	handleSetDefaultProject,
	handleUpdateProject,
	getMe,
	listOrganizationMembers,
	listProjectMembers,
	listProjectAuditEvents,
	listProjects,
	putOrganizationMember,
	putProjectMember,
	restoreProject,
	setDefaultProject,
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
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor,
			actorId:
				c.req.header("x-test-actor-id") ??
				actorIds[actor as keyof typeof actorIds] ??
				actorIds.member,
			organizationId: ORGANIZATION,
		});
	await next();
});
api.openapi(createProject, handleCreateProject);
api.openapi(setDefaultProject, handleSetDefaultProject);
api.openapi(deleteProject, handleDeleteProject);
api.openapi(getProjectDeletionStatus, handleGetProjectDeletionStatus);
api.openapi(getMe, handleGetMe);
api.openapi(listProjects, handleListProjects);
api.openapi(getProject, handleGetProject);
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

beforeEach(() => {
	query.mockReset();
	query.mockImplementation(defaultQuery);
	command.mockClear();
	command.mockImplementation(async () => undefined);
});

describe("project authorization routes", () => {
	it("logs the safe SQLSTATE when project creation has an internal database failure", async () => {
		const originalError = logger.error;
		const errors: Array<{ event: string; cause: unknown }> = [];
		logger.error = (event, cause) => errors.push({ event, cause });
		const secret = "password=do-not-log";
		query.mockImplementation(async (sql: string, values: string[] = []) => {
			if (sql.includes("INSERT INTO projects"))
				throw Object.assign(new Error(secret), { code: "42P01" });
			return defaultQuery(sql, values);
		});
		try {
			const response = await request("owner", "/v1/projects", {
				method: "POST",
				body: JSON.stringify({ name: "New Project", slug: "new-project" }),
			});
			expect(response.status).toBe(500);
			expect(errors).toEqual([
				{
					event: "projects.request_failed",
					cause: expect.objectContaining({ code: "42P01" }),
				},
			]);
		} finally {
			logger.error = originalError;
		}
	});

	it("sets an active same-organization default and permanently deletes only a confirmed non-default project", async () => {
		const setDefault = await request(
			"owner",
			"/v1/organizations/current/default-project",
			{
				method: "PATCH",
				body: JSON.stringify({ project_id: PROJECT }),
			},
		);
		const rejectedConfirmation = await request(
			"owner",
			`/v1/projects/${PROJECT}`,
			{
				method: "DELETE",
				body: JSON.stringify({ confirmation_name: "wrong" }),
			},
		);
		const deleted = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "DELETE",
			body: JSON.stringify({ confirmation_name: "Project One" }),
		});

		expect(setDefault.status).toBe(200);
		expect(rejectedConfirmation.status).toBe(409);
		expect(deleted.status).toBe(204);
		expect(
			query.mock.calls.some(([sql]) => sql.includes("deletion_attempted")),
		).toBe(true);
		expect(
			query.mock.calls.some(([sql]) => sql.startsWith("DELETE FROM projects")),
		).toBe(true);
		expect(command).toHaveBeenCalledTimes(2);
		for (const [input] of command.mock.calls)
			expect(input.query).toContain("SETTINGS mutations_sync = 1");
		expect(
			query.mock.calls.some(([sql]) =>
				sql.startsWith("SELECT set_config('glasshouse.project_deletion_id'"),
			),
		).toBe(true);
		expect(
			query.mock.calls.some(([sql]) =>
				sql.startsWith("DELETE FROM governance_policy_versions"),
			),
		).toBe(true);
		expect(
			query.mock.calls.some(([sql]) => sql.includes("SET project_id = NULL")),
		).toBe(false);
	});
	it("cleans 0094 run-scope quarantines during authorized project deletion", async () => {
		const response = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "DELETE",
			body: JSON.stringify({ confirmation_name: "Project One" }),
		});

		expect(response.status).toBe(204);
		expect(
			query.mock.calls
				.filter(([sql]) =>
					[
						"DELETE FROM experiment_result_run_scope_quarantine WHERE project_id = $1",
						"DELETE FROM experiment_task_run_item_mismatch_quarantine WHERE project_id = $1",
					].includes(sql as string),
				)
				.map(([sql, values]) => ({ sql, values })),
		).toEqual([
			{
				sql: "DELETE FROM experiment_result_run_scope_quarantine WHERE project_id = $1",
				values: [PROJECT],
			},
			{
				sql: "DELETE FROM experiment_task_run_item_mismatch_quarantine WHERE project_id = $1",
				values: [PROJECT],
			},
		]);
	});
	it("does not delete the PostgreSQL project when ClickHouse cleanup fails", async () => {
		command.mockImplementationOnce(async () => {
			throw new Error("ClickHouse mutation failed");
		});
		const response = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "DELETE",
			body: JSON.stringify({ confirmation_name: "Project One" }),
		});

		expect(response.status).toBe(409);
		expect(
			query.mock.calls.some(([sql]) => sql.startsWith("DELETE FROM projects")),
		).toBe(false);
		expect(
			query.mock.calls.some(([sql]) =>
				sql.startsWith("UPDATE project_deletion_jobs SET status = 'failed'"),
			),
		).toBe(true);
		const retried = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "DELETE",
			body: JSON.stringify({ confirmation_name: "Project One" }),
		});
		expect(retried.status).toBe(204);
		expect(
			query.mock.calls.filter(([sql]) =>
				sql.startsWith("INSERT INTO project_deletion_jobs"),
			).length,
		).toBe(2);
	});
	it("allows only an organization owner to start permanent deletion", async () => {
		query.mockImplementation(async (sql: string, values: string[] = []) =>
			sql.startsWith("SELECT p.name, p.status FROM projects")
				? { rows: [] }
				: defaultQuery(sql, values),
		);
		const response = await request("manager", `/v1/projects/${PROJECT}`, {
			method: "DELETE",
			body: JSON.stringify({ confirmation_name: "Project One" }),
		});

		expect(response.status).toBe(404);
	});

	it("blocks membership writes after a failed deletion attempt", async () => {
		command.mockImplementationOnce(async () => {
			throw new Error("ClickHouse mutation failed");
		});
		const failedDeletion = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "DELETE",
			body: JSON.stringify({ confirmation_name: "Project One" }),
		});
		expect(failedDeletion.status).toBe(409);

		query.mockImplementation(async (sql: string, values: string[] = []) => {
			if (sql.includes("p.status <> 'deleting'")) return { rows: [] };
			return defaultQuery(sql, values);
		});
		const put = await request(
			"owner",
			`/v1/projects/${PROJECT}/members/member`,
			{
				method: "PUT",
				body: JSON.stringify({ actor_subject: "member", role: "read_only" }),
			},
		);
		const remove = await request(
			"owner",
			`/v1/projects/${PROJECT}/members/member`,
			{ method: "DELETE" },
		);

		expect(put.status).toBe(404);
		expect(remove.status).toBe(404);
	});
	it("freezes organization membership PUT and DELETE after a failed deletion", async () => {
		command.mockImplementationOnce(async () => {
			throw new Error("ClickHouse mutation failed");
		});
		const failedDeletion = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "DELETE",
			body: JSON.stringify({ confirmation_name: "Project One" }),
		});
		expect(failedDeletion.status).toBe(409);

		query.mockImplementation(async (sql: string, values: string[] = []) => {
			if (sql.startsWith("SELECT authorization_allows_organization"))
				return { rows: [{ allowed: true }] };
			if (sql.includes("FROM local_credentials")) return { rows: [] };
			if (
				sql.startsWith("BEGIN") ||
				sql.startsWith("COMMIT") ||
				sql.startsWith("ROLLBACK") ||
				sql.startsWith("SELECT id FROM projects") ||
				sql.startsWith("SELECT id FROM organizations") ||
				sql.startsWith("SELECT actor_subject FROM organization_memberships") ||
				sql.startsWith("SELECT actor_id FROM organization_actor_roles") ||
				sql.startsWith("SELECT lock_project_audit_provenance")
			)
				return { rows: [] };
			expect(sql).toContain("unfrozen AS MATERIALIZED");
			expect(sql).toContain(
				"FROM projects WHERE organization_id = $1 FOR UPDATE",
			);
			expect(sql).toContain("locked_projects WHERE status = 'deleting'");
			expect(values[0]).toBe(ORGANIZATION);
			return { rows: [] };
		});
		const put = await request("owner", "/v1/organization/members/member", {
			method: "PUT",
			body: JSON.stringify({ actor_subject: "member", role: "admin" }),
		});
		const remove = await request("owner", "/v1/organization/members/member", {
			method: "DELETE",
		});

		expect(await put.json()).toEqual({
			code: "FORBIDDEN",
			message: "Forbidden",
		});
		expect(await remove.json()).toEqual({
			code: "FORBIDDEN",
			message: "Forbidden",
		});
		expect(put.status).toBe(403);
		expect(remove.status).toBe(403);
	});
	it("checkpoints ClickHouse cleanup before ordered relational finalization", async () => {
		const response = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "DELETE",
			body: JSON.stringify({ confirmation_name: "Project One" }),
		});

		expect(response.status).toBe(204);
		const sql = query.mock.calls.map(([statement]) => statement as string);
		const index = (prefix: string) =>
			sql.findIndex((statement) => statement.startsWith(prefix));
		expect(index("SELECT lock_project_audit_provenance")).toBeLessThan(
			index("SELECT p.name, p.status FROM projects"),
		);
		expect(index("SELECT lock_project_audit_provenance")).toBeGreaterThan(
			index("BEGIN"),
		);
		expect(index("DELETE FROM projects")).toBeGreaterThan(
			index("SELECT lock_project_audit_provenance"),
		);
		expect(
			index("UPDATE project_deletion_jobs SET status = 'traces_cleaned'"),
		).toBeGreaterThan(index("INSERT INTO project_deletion_jobs"));
		expect(
			index("UPDATE project_deletion_jobs SET status = 'clickhouse_cleaned'"),
		).toBeGreaterThan(
			index("UPDATE project_deletion_jobs SET status = 'traces_cleaned'"),
		);
		expect(index("DELETE FROM prompt_optimization_events")).toBeLessThan(
			index("DELETE FROM prompt_optimization_jobs"),
		);
		expect(index("DELETE FROM prompt_optimization_jobs")).toBeLessThan(
			index("DELETE FROM prompts"),
		);
		expect(index("DELETE FROM benchmark_runs")).toBeLessThan(
			index("DELETE FROM benchmark_suites"),
		);
		expect(index("DELETE FROM benchmark_suites")).toBeLessThan(
			index("DELETE FROM datasets"),
		);
		expect(index("DELETE FROM feedback_reviews")).toBeLessThan(
			index("DELETE FROM dataset_items"),
		);
		expect(index("DELETE FROM agent_introspection_reports")).toBeLessThan(
			index("DELETE FROM agent_introspection_report_scope_quarantine"),
		);
		expect(
			index("DELETE FROM agent_introspection_report_scope_quarantine"),
		).toBeLessThan(index("DELETE FROM experiment_result_run_scope_quarantine"));
		expect(
			index("DELETE FROM experiment_result_run_scope_quarantine"),
		).toBeLessThan(
			index("DELETE FROM experiment_task_run_item_mismatch_quarantine"),
		);
		expect(
			index("DELETE FROM experiment_task_run_item_mismatch_quarantine"),
		).toBeLessThan(index("DELETE FROM experiment_tasks"));
		expect(
			sql.find((statement) =>
				statement.startsWith(
					"DELETE FROM experiment_result_run_scope_quarantine",
				),
			),
		).toBe(
			"DELETE FROM experiment_result_run_scope_quarantine WHERE project_id = $1",
		);
		expect(index("DELETE FROM dataset_item_input_quarantine")).toBeLessThan(
			index("DELETE FROM dataset_items"),
		);
		expect(
			sql.find((statement) =>
				statement.startsWith("DELETE FROM dataset_item_input_quarantine"),
			),
		).toBe("DELETE FROM dataset_item_input_quarantine WHERE project_id = $1");
		expect(index("DELETE FROM dataset_items")).toBeLessThan(
			index("DELETE FROM scores"),
		);
		expect(
			index("UPDATE project_deletion_jobs SET status = 'completed'"),
		).toBeGreaterThan(index("DELETE FROM projects"));
		expect(command.mock.calls.map(([input]) => input.query)).toEqual([
			expect.stringContaining("ALTER TABLE traces DELETE"),
			expect.stringContaining("ALTER TABLE observations DELETE"),
		]);
	});
	it("rejects members from creating projects or changing organization roles", async () => {
		const create = await request("member", "/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "New Project", slug: "new-project" }),
		});
		const promote = await request("member", "/v1/organization/members/member", {
			method: "PUT",
			body: JSON.stringify({ actor_subject: "member", role: "admin" }),
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
				body: JSON.stringify({ actor_subject: "member", role: "read_only" }),
			},
		);

		expect(update.status).toBe(200);
		expect(member.status).toBe(200);
	});

	it("uses durable Admin authorization when no legacy caller membership exists", async () => {
		const durableActor = {
			actorId: actorIds.owner,
			canonicalSubject: "owner",
			role: "admin",
		};
		const legacyOrganizationMemberships = new Map([
			["member", "member" as const],
		]);
		let createdLegacyCallerMembership = false;
		const deletionJob = {
			status: "pending",
			traces_cleaned_at: null,
			observations_cleaned_at: null,
			completed_at: null,
			attempt_count: 1,
		};

		query.mockImplementation(async (sql: string, values: string[] = []) => {
			if (
				sql.startsWith("SELECT om.actor_subject FROM organization_memberships")
			)
				return { rows: [] };
			if (sql.startsWith("SELECT actor_subject FROM organization_memberships"))
				return {
					rows:
						values[2] && legacyOrganizationMemberships.has(values[2])
							? [{ actor_subject: values[2] }]
							: [],
				};
			if (sql.startsWith("SELECT pm.actor_subject FROM project_memberships"))
				return {
					rows: values[3] === "member" ? [{ actor_subject: "member" }] : [],
				};
			if (sql.startsWith("SELECT actor_id FROM organization_actor_roles"))
				return { rows: [{ actor_id: durableActor.actorId }] };
			if (sql.startsWith("SELECT om.role")) return { rows: [] };
			if (
				sql.startsWith("SELECT role.role AS durable_role") &&
				sql.includes("FROM organizations")
			)
				return {
					rows: [
						{
							durable_role: durableActor.role,
							default_project_id: OTHER_PROJECT,
						},
					],
				};
			if (
				sql.startsWith("SELECT 1 FROM organization_actor_roles role") &&
				sql.includes("FROM actor_identities")
			)
				return { rows: [{ "?column?": 1 }] };
			if (
				sql.startsWith("SELECT p.id, p.name, p.slug") &&
				sql.includes("ORDER BY p.created_at")
			)
				return {
					rows: [
						{
							id: PROJECT,
							name: "Project One",
							slug: "project-one",
							status: "active",
							created_at: createdAt,
							archived_at: null,
							project_role: durableActor.role,
							can_manage: true,
							can_govern: true,
							is_default: false,
						},
					],
				};
			if (sql.includes("INSERT INTO projects")) {
				const resolvesLegacySubject =
					sql.includes("JOIN actor_identities identity") &&
					sql.includes("JOIN organization_memberships membership");
				const legacySubject = [...legacyOrganizationMemberships.keys()].find(
					(subject) => subject === durableActor.canonicalSubject,
				);
				if (!resolvesLegacySubject && !legacySubject)
					throw Object.assign(new Error("legacy membership parent missing"), {
						code: "23503",
					});
				createdLegacyCallerMembership = Boolean(legacySubject);
				return defaultQuery(sql, values);
			}
			if (
				sql.includes("UPDATE organizations SET default_project_id") &&
				sql.includes("FROM organization_memberships")
			)
				return { rows: [] };
			if (sql.startsWith("SELECT pm.actor_subject, pm.role, pm.created_at"))
				return sql.includes("JOIN organization_memberships om")
					? { rows: [] }
					: {
							rows: [
								{
									actor_subject: "member",
									role: "member",
									created_at: createdAt,
								},
							],
						};
			if (
				sql.includes("INSERT INTO project_memberships") &&
				sql.includes("project_membership_created")
			) {
				if (sql.includes("JOIN organization_memberships om"))
					return { rows: [] };
				return defaultQuery(sql, values);
			}
			if (
				sql.includes("DELETE FROM project_memberships") &&
				sql.includes("project_membership_removed")
			) {
				if (sql.includes("JOIN organization_memberships om"))
					return { rows: [] };
				return defaultQuery(sql, values);
			}
			if (
				sql.includes("INSERT INTO organization_memberships") &&
				sql.includes("organization_membership_created")
			) {
				if (
					sql.startsWith(
						"WITH authorization AS MATERIALIZED (SELECT 1 FROM organization_memberships",
					)
				)
					return { rows: [] };
				return defaultQuery(sql, values);
			}
			if (sql.startsWith("SELECT om.actor_subject, om.role, om.created_at"))
				return sql.includes("actor_om")
					? { rows: [] }
					: {
							rows: [...legacyOrganizationMemberships].map(
								([actor_subject, role]) => ({
									actor_subject,
									role,
									created_at: createdAt,
								}),
							),
						};
			if (
				sql.includes("DELETE FROM organization_memberships") &&
				sql.includes("organization_membership_removed")
			) {
				if (
					sql.startsWith(
						"WITH authorization AS MATERIALIZED (SELECT 1 FROM organization_memberships",
					)
				)
					return { rows: [] };
				return defaultQuery(sql, values);
			}
			if (sql.startsWith("SELECT p.name, p.status FROM projects"))
				return sql.includes("JOIN organization_memberships")
					? { rows: [] }
					: defaultQuery(sql, values);
			if (
				sql.startsWith(
					"SELECT j.status, j.traces_cleaned_at, j.observations_cleaned_at",
				)
			)
				return sql.includes("JOIN organization_memberships")
					? { rows: [] }
					: { rows: [{ ...deletionJob }] };
			return defaultQuery(sql, values);
		});
		command.mockImplementationOnce(async () => {
			throw new Error("ClickHouse mutation failed");
		});

		const me = await request("owner", "/v1/me");
		const list = await request("owner", "/v1/projects");
		const create = await request("owner", "/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "New Project", slug: "new-project" }),
		});
		const archive = await request("owner", `/v1/projects/${PROJECT}/archive`, {
			method: "POST",
		});
		const restore = await request("owner", `/v1/projects/${PROJECT}/restore`, {
			method: "POST",
		});
		const selectProject = await request(
			"owner",
			"/v1/organizations/current/default-project",
			{
				method: "PATCH",
				body: JSON.stringify({ project_id: PROJECT }),
			},
		);
		const projectMembers = await request(
			"owner",
			`/v1/projects/${PROJECT}/members`,
		);
		const putProjectMemberResponse = await request(
			"owner",
			`/v1/projects/${PROJECT}/members/member`,
			{
				method: "PUT",
				body: JSON.stringify({ actor_subject: "member", role: "read_only" }),
			},
		);
		const deleteProjectMemberResponse = await request(
			"owner",
			`/v1/projects/${PROJECT}/members/member`,
			{ method: "DELETE" },
		);
		const putOrganizationMemberResponse = await request(
			"owner",
			"/v1/organization/members/member",
			{
				method: "PUT",
				body: JSON.stringify({ actor_subject: "member", role: "user" }),
			},
		);
		const organizationMembers = await request(
			"owner",
			"/v1/organization/members",
		);
		const deleteOrganizationMemberResponse = await request(
			"owner",
			"/v1/organization/members/member",
			{ method: "DELETE" },
		);
		const failedDeletion = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "DELETE",
			body: JSON.stringify({ confirmation_name: "Project One" }),
		});
		const deletionStatusResponse = await request(
			"owner",
			`/v1/projects/${PROJECT}/deletion`,
		);
		const retriedDeletion = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "DELETE",
			body: JSON.stringify({ confirmation_name: "Project One" }),
		});
		const projectMemberItems = projectMembers.ok
			? ((await projectMembers.json()) as { items: unknown[] }).items.length
			: null;
		const organizationMemberItems = organizationMembers.ok
			? ((await organizationMembers.json()) as { items: unknown[] }).items
					.length
			: null;

		expect({
			me: me.status,
			list: list.status,
			create: create.status,
			archive: archive.status,
			restore: restore.status,
			selectProject: selectProject.status,
			projectMembers: [projectMembers.status, projectMemberItems],
			putProjectMember: putProjectMemberResponse.status,
			deleteProjectMember: deleteProjectMemberResponse.status,
			putOrganizationMember: putOrganizationMemberResponse.status,
			organizationMembers: [
				organizationMembers.status,
				organizationMemberItems,
			],
			deleteOrganizationMember: deleteOrganizationMemberResponse.status,
			failedDeletion: failedDeletion.status,
			deletionStatus: deletionStatusResponse.status,
			retriedDeletion: retriedDeletion.status,
		}).toEqual({
			me: 200,
			list: 200,
			create: 201,
			archive: 200,
			restore: 200,
			selectProject: 200,
			projectMembers: [200, 1],
			putProjectMember: 200,
			deleteProjectMember: 204,
			putOrganizationMember: 200,
			organizationMembers: [200, 1],
			deleteOrganizationMember: 204,
			failedDeletion: 409,
			deletionStatus: 200,
			retriedDeletion: 204,
		});
		expect(createdLegacyCallerMembership).toBe(false);
		expect(command).toHaveBeenCalledTimes(3);
	});

	it("lets a durable Admin update a project without a legacy manager projection", async () => {
		query.mockImplementation(async (sql: string, values: string[] = []) => {
			if (
				sql.startsWith("WITH authz AS MATERIALIZED") &&
				sql.includes("UPDATE projects") &&
				sql.includes("om.role = 'owner' OR pm.role = 'manager'")
			)
				return { rows: [] };
			return defaultQuery(sql, values);
		});

		const response = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "PATCH",
			body: JSON.stringify({ name: "Renamed" }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(
			expect.objectContaining({ id: PROJECT, name: "Renamed" }),
		);
	});

	it("keeps durable User project detail and lifecycle access without a legacy projection", async () => {
		query.mockImplementation(async (sql: string, values: string[] = []) => {
			if (sql.startsWith("SELECT pm.actor_subject FROM project_memberships"))
				return { rows: [] };
			if (sql.includes("CASE WHEN om.role = 'owner' THEN 'owner'"))
				return { rows: [] };
			if (
				sql.startsWith("SELECT p.id, p.name, p.slug") &&
				sql.includes("authorization_effective_project_role")
			)
				return {
					rows: [
						{
							id: PROJECT,
							name: "Renamed",
							slug: "project",
							status: "active",
							created_at: createdAt,
							archived_at: null,
							project_role: "user",
							can_manage: true,
							can_govern: true,
							is_default: false,
						},
					],
				};
			if (
				sql.startsWith("SELECT access.effective_role AS project_role") &&
				sql.includes("authorization_effective_project_role")
			)
				return { rows: [{ project_role: "user" }] };
			if (
				sql.startsWith("SELECT authorization_allows_project") &&
				sql.includes("AS can_manage")
			)
				return { rows: [{ can_manage: true, can_govern: true }] };
			return defaultQuery(sql, values);
		});

		const rename = await request("manager", `/v1/projects/${PROJECT}`, {
			method: "PATCH",
			body: JSON.stringify({ name: "Renamed" }),
		});
		const detail = await request("manager", `/v1/projects/${PROJECT}`);
		const archive = await request(
			"manager",
			`/v1/projects/${PROJECT}/archive`,
			{ method: "POST" },
		);
		const restore = await request(
			"manager",
			`/v1/projects/${PROJECT}/restore`,
			{ method: "POST" },
		);

		expect(rename.status).toBe(200);
		for (const response of [detail, archive, restore]) {
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(
				expect.objectContaining({
					id: PROJECT,
					project_role: "user",
					can_manage: true,
				}),
			);
		}
	});

	it("uses the verified actor ID for durable project authorization", async () => {
		const verifiedActorId = "33333333-3333-4333-8333-333333333333";
		query.mockImplementation(async (sql: string, values: string[] = []) => {
			if (sql.includes("authz AS MATERIALIZED")) {
				return values.at(-1) === verifiedActorId
					? defaultQuery(sql, values)
					: { rows: [] };
			}
			return defaultQuery(sql, values);
		});

		const canonicalEquivalent = await request(
			" OWNER ",
			`/v1/projects/${PROJECT}`,
			{
				method: "PATCH",
				headers: { "x-test-actor-id": verifiedActorId },
				body: JSON.stringify({ name: "Renamed" }),
			},
		);
		const collision = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "PATCH",
			headers: { "x-test-actor-id": "44444444-4444-4444-8444-444444444444" },
			body: JSON.stringify({ name: "Renamed" }),
		});
		const quarantined = await request(
			"legacy user",
			`/v1/projects/${PROJECT}`,
			{
				method: "PATCH",
				headers: { "x-test-actor-id": "55555555-5555-4555-8555-555555555555" },
				body: JSON.stringify({ name: "Renamed" }),
			},
		);

		expect(canonicalEquivalent.status).toBe(200);
		expect(collision.status).toBe(404);
		expect(quarantined.status).toBe(404);
		const [sql, values] = query.mock.calls.find(([sql]) =>
			(sql as string).includes("authz AS MATERIALIZED"),
		)!;
		expect(sql).toContain(
			"authorization_effective_project_role(p.organization_id, p.id, $6)",
		);
		expect(sql).toContain(
			"authorization_allows_project($4, $3, $6, 'project_manage')",
		);
		expect(values).toContain(verifiedActorId);
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
					sql.includes("'project_updated'") &&
					sql.includes("p.id = o.default_project_id AS is_default"),
			),
		).toBe(true);
		const statements = query.mock.calls.map(
			([statement]) => statement as string,
		);
		const index = (prefix: string) =>
			statements.findIndex((statement) => statement.startsWith(prefix));
		expect(index("SELECT lock_project_audit_provenance")).toBeGreaterThan(
			index("SELECT p.id FROM projects p"),
		);
	});

	it("returns the canonical default flag when renaming the default project", async () => {
		query.mockImplementation(async (sql: string, values: string[] = []) => {
			if (!sql.includes("JOIN organizations o ON o.id = $4"))
				return defaultQuery(sql, values);
			return {
				rows: [
					{
						id: PROJECT,
						name: "Renamed",
						slug: "project",
						status: "active",
						created_at: createdAt,
						archived_at: null,
						project_role: "owner",
						is_default: true,
					},
				],
			};
		});

		const response = await request("owner", `/v1/projects/${PROJECT}`, {
			method: "PATCH",
			body: JSON.stringify({ name: "Renamed" }),
		});

		expect(response.status).toBe(200);
		expect((await response.json()).is_default).toBe(true);
	});

	it("lists actor roles and archived projects only in management mode", async () => {
		query.mockImplementationOnce(async () => ({
			rows: [
				{
					role: "member",
					durable_role: "read_only",
					default_project_id: PROJECT,
				},
			],
		}));
		query.mockImplementationOnce(async (sql: string) => {
			expect(sql).toContain("authorization_effective_project_role");
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
		expect((await active.json()).items[0].project_role).toBe("read_only");

		query.mockImplementationOnce(async () => ({
			rows: [{ role: "member" }],
		}));
		query.mockImplementationOnce(async (sql: string) => {
			expect(sql).toContain("$2::boolean");
			expect(sql).toContain("authorization_allows_project");
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
		query.mockImplementationOnce(async () => ({
			rows: [
				{
					role: "member",
					durable_role: "read_only",
					default_project_id: PROJECT,
				},
			],
		}));
		query.mockImplementationOnce(async (sql: string) => {
			expect(sql).toContain("authorization_effective_project_role");
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
		const body = await response.json();
		expect(body.projects).toEqual([
			expect.objectContaining({ id: PROJECT, project_role: "read_only" }),
		]);
		expect(body.actor_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(body.effective_organization_role_id).toBe("organization:user");
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
				body: JSON.stringify({ actor_subject: "member", role: "read_only" }),
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
		const [auditSql] = query.mock.calls.find(([sql]) =>
			sql.startsWith("SELECT e.id, e.actor_subject, e.event_type"),
		)!;
		expect(auditSql).toContain("e.organization_id = $3");
		expect((await audit.json()).items).toEqual([
			{
				id: "33333333-3333-4333-8333-333333333333",
				actor_subject: "owner",
				event_type: "project_archived",
				created_at: createdAt.toISOString(),
			},
		]);
	});

	it("locks authorization mutations against concurrent role changes", async () => {
		await request("owner", "/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "New Project", slug: "new-project" }),
		});
		await request("manager", `/v1/projects/${PROJECT}/archive`, {
			method: "POST",
		});
		await request("manager", `/v1/projects/${PROJECT}/restore`, {
			method: "POST",
		});
		await request("manager", `/v1/projects/${PROJECT}/members/member`, {
			method: "PUT",
			body: JSON.stringify({ actor_subject: "member", role: "read_only" }),
		});
		await request("manager", `/v1/projects/${PROJECT}/members/member`, {
			method: "DELETE",
		});
		await request("owner", "/v1/organization/members/member", {
			method: "PUT",
			body: JSON.stringify({ actor_subject: "member", role: "user" }),
		});
		await request("owner", "/v1/organization/members/member", {
			method: "DELETE",
		});

		const mutations = query.mock.calls
			.map(([sql]) => sql)
			.filter(
				(sql) =>
					sql.includes("authz AS MATERIALIZED") ||
					sql.includes("authorized_actor AS MATERIALIZED"),
			);
		expect(mutations.length).toBeGreaterThanOrEqual(5);
		for (const sql of mutations) {
			expect(sql).toMatch(/(?:authz|authorized_actor) AS MATERIALIZED/);
			expect(sql).toContain("FOR UPDATE");
			expect(sql).toContain(
				"audit AS (INSERT INTO project_authorization_audit_events",
			);
			expect(sql).toContain("SELECT");
		}
		expect(
			mutations
				.filter((sql) => sql.includes("'organization_membership_"))
				.every(
					(sql) =>
						sql.includes("audit_project AS MATERIALIZED") &&
						sql.includes("projects WHERE organization_id = $1"),
				),
		).toBe(true);
	});

	it("serializes archive-time work cancellation with the project row", async () => {
		await request("manager", `/v1/projects/${PROJECT}/archive`, {
			method: "POST",
		});

		const statements = query.mock.calls.map(([sql]) => sql);
		expect(statements).toContainEqual(
			expect.stringContaining("SELECT actor_id FROM organization_actor_roles"),
		);
		const durableAuthorization = statements.find((statement) =>
			statement.startsWith("SELECT access.effective_role AS project_role"),
		);
		expect(durableAuthorization).toContain(
			"authorization_effective_project_role(p.organization_id, p.id, $2)",
		);
		expect(durableAuthorization).toContain(
			"p.id = $1 AND p.organization_id = $3",
		);
		expect(durableAuthorization).toContain(
			"authorization_allows_project($3, $1, $2, 'project_manage')",
		);
		expect(durableAuthorization).toContain("FOR UPDATE OF p");
		expect(statements).toContainEqual(
			expect.stringContaining(
				"SELECT p.id FROM projects p WHERE p.id = $1 AND p.organization_id = $2",
			),
		);
		expect(statements).toContainEqual(
			expect.stringContaining("UPDATE experiments SET status = 'cancelled'"),
		);
		expect(statements).toContainEqual(
			expect.stringContaining(
				"UPDATE prompt_optimization_jobs SET status = 'stopped'",
			),
		);
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

		for (const response of [archive, remove]) {
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				code: "NOT_FOUND",
				message: "Project is not available",
			});
		}
		expect(
			query.mock.calls.some(([sql]) =>
				sql.includes("authorization_effective_project_role"),
			),
		).toBe(true);
		expect(audit.status).toBeLessThan(500);
	});

	it("does not use a same-subject manager role from another organization", async () => {
		const members = await request(
			"cross-org-manager",
			`/v1/projects/${OTHER_PROJECT}/members`,
		);
		const audit = await request(
			"cross-org-manager",
			`/v1/projects/${OTHER_PROJECT}/audit-events`,
		);

		for (const response of [members, audit]) {
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

	it("records created membership facts only for inserts and updated facts only for role changes", async () => {
		await request("owner", `/v1/projects/${PROJECT}/members/member`, {
			method: "PUT",
			body: JSON.stringify({ actor_subject: "member", role: "user" }),
		});
		await request("owner", "/v1/organization/members/member", {
			method: "PUT",
			body: JSON.stringify({ actor_subject: "member", role: "user" }),
		});

		const membershipUpserts = query.mock.calls
			.map(([sql]) => sql)
			.filter(
				(sql) => sql.includes("ON CONFLICT") && sql.includes("membership"),
			);
		expect(membershipUpserts).toHaveLength(2);
		for (const sql of membershipUpserts) {
			expect(sql).toContain("(xmax = 0) AS created");
			expect(sql).toContain("role IS DISTINCT FROM EXCLUDED.role");
			expect(sql).toContain("WHEN created THEN");
			expect(sql).toContain("membership_created");
			expect(sql).toContain("membership_updated");
		}
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
			expect(sql).toContain("authorization_effective_project_role");
			return {
				rows: [
					{
						effective_role: "admin" as const,
						enforcement: "strict" as const,
						project_status: "active" as const,
						allowed: true,
					},
				],
			};
		});

		const scope = await resolveAuthorizedProjectScope(
			{ query: scopeQuery } as never,
			{
				actor: "owner",
				actorId: "33333333-3333-4333-8333-333333333333",
				organizationId: ORGANIZATION,
			},
			PROJECT,
		);

		expect(scope.projectRole).toBe("admin");
	});

	it("does not grant an organization member scope for a project without membership", async () => {
		const scopeQuery = mock(async (sql: string) => {
			expect(sql).toContain("authorization_allows_project");
			return {
				rows: [
					{
						effective_role: null,
						enforcement: "strict",
						project_status: "active",
						allowed: false,
					},
				],
			};
		});

		await expect(
			resolveAuthorizedProjectScope(
				{ query: scopeQuery } as never,
				{
					actor: "member",
					actorId: "33333333-3333-4333-8333-333333333333",
					organizationId: ORGANIZATION,
				},
				OTHER_PROJECT,
			),
		).rejects.toThrow("Project is not available");
	});
});
