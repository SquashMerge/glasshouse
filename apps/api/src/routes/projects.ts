import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { QueryResultRow } from "pg";
import { pgPool } from "../db/postgres.js";
import { ch } from "../db/clickhouse.js";
import {
	CreateProjectInput,
	DeleteProjectInput,
	ListProjectsQuery,
	Me,
	MemberInput,
	OrganizationMember,
	OrganizationMemberInput,
	Project,
	ProjectAuditEvent,
	ProjectDeletionStatus,
	ProjectErrorResponses,
	ProjectList,
	ProjectMember,
	SetDefaultProjectInput,
	UpdateProjectInput,
} from "../schemas/projects.js";
import {
	assertOrganizationAccess,
	assertTenantProjectAccess,
	TenantScopeError,
	trustedTenant,
} from "../tenancy.js";
import type { ProjectOperation } from "../authorization-policy.js";

const Id = z.string().uuid();
const projectParams = z.object({ id: Id });
const memberParams = z.object({ id: Id, actor: z.string().min(1) });
const organizationMemberParams = z.object({ actor: z.string().min(1) });
const ok = (schema: z.ZodType) => ({
	200: { description: "OK", content: { "application/json": { schema } } },
	...ProjectErrorResponses,
});
export const getMe = createRoute({
	method: "get",
	path: "/v1/me",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	responses: ok(Me),
});
export const listProjects = createRoute({
	method: "get",
	path: "/v1/projects",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: { query: ListProjectsQuery },
	responses: ok(ProjectList),
});
export const createProject = createRoute({
	method: "post",
	path: "/v1/projects",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateProjectInput } } },
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: Project } },
		},
		...ProjectErrorResponses,
	},
});
export const getProject = createRoute({
	method: "get",
	path: "/v1/projects/{id}",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: { params: projectParams },
	responses: ok(Project),
});
export const setDefaultProject = createRoute({
	method: "patch",
	path: "/v1/organizations/current/default-project",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: SetDefaultProjectInput } },
		},
	},
	responses: ok(Project),
});
export const deleteProject = createRoute({
	method: "delete",
	path: "/v1/projects/{id}",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: {
		params: projectParams,
		body: {
			required: true,
			content: { "application/json": { schema: DeleteProjectInput } },
		},
	},
	responses: { 204: { description: "Deleted" }, ...ProjectErrorResponses },
});
export const getProjectDeletionStatus = createRoute({
	method: "get",
	path: "/v1/projects/{id}/deletion",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: { params: projectParams },
	responses: ok(ProjectDeletionStatus),
});
export const updateProject = createRoute({
	method: "patch",
	path: "/v1/projects/{id}",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: {
		params: projectParams,
		body: { content: { "application/json": { schema: UpdateProjectInput } } },
	},
	responses: ok(Project),
});
export const archiveProject = createRoute({
	method: "post",
	path: "/v1/projects/{id}/archive",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: { params: projectParams },
	responses: ok(Project),
});
export const restoreProject = createRoute({
	method: "post",
	path: "/v1/projects/{id}/restore",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: { params: projectParams },
	responses: ok(Project),
});
export const listProjectMembers = createRoute({
	method: "get",
	path: "/v1/projects/{id}/members",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: { params: projectParams },
	responses: ok(z.object({ items: z.array(ProjectMember) })),
});
export const listProjectAuditEvents = createRoute({
	method: "get",
	path: "/v1/projects/{id}/audit-events",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: { params: projectParams },
	responses: ok(z.object({ items: z.array(ProjectAuditEvent) })),
});
export const putProjectMember = createRoute({
	method: "put",
	path: "/v1/projects/{id}/members/{actor}",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: {
		params: memberParams,
		body: { content: { "application/json": { schema: MemberInput } } },
	},
	responses: ok(ProjectMember),
});
export const deleteProjectMember = createRoute({
	method: "delete",
	path: "/v1/projects/{id}/members/{actor}",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: { params: memberParams },
	responses: { 204: { description: "Deleted" }, ...ProjectErrorResponses },
});
export const putOrganizationMember = createRoute({
	method: "put",
	path: "/v1/organization/members/{actor}",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: {
		params: organizationMemberParams,
		body: {
			content: { "application/json": { schema: OrganizationMemberInput } },
		},
	},
	responses: ok(OrganizationMember),
});
export const listOrganizationMembers = createRoute({
	method: "get",
	path: "/v1/organization/members",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	responses: ok(z.object({ items: z.array(OrganizationMember) })),
});
export const deleteOrganizationMember = createRoute({
	method: "delete",
	path: "/v1/organization/members/{actor}",
	tags: ["projects"],
	security: [{ basicAuth: [] }],
	request: { params: organizationMemberParams },
	responses: { 204: { description: "Deleted" }, ...ProjectErrorResponses },
});

type Row = {
	id: string;
	name: string;
	slug: string;
	status: "active" | "archived" | "deleting";
	created_at: Date;
	archived_at: Date | null;
	project_role: "owner" | "manager" | "member";
	is_default?: boolean;
};
function publicProjectRole(role: Row["project_role"]) {
	if (role === "owner") return "admin" as const;
	if (role === "manager") return "user" as const;
	return "read_only" as const;
}
function publicOrganizationRole(role: "owner" | "member") {
	return role === "owner" ? ("admin" as const) : ("user" as const);
}
function legacyProjectRole(role: "user" | "read_only") {
	return role === "user" ? ("manager" as const) : ("member" as const);
}
function legacyOrganizationRole(role: "admin" | "user") {
	return role === "admin" ? ("owner" as const) : ("member" as const);
}
const project = (row: Row) => ({
	...row,
	project_role: publicProjectRole(row.project_role),
	is_default: row.is_default ?? false,
	created_at: row.created_at.toISOString(),
	archived_at: row.archived_at?.toISOString() ?? null,
});
type DeletionJob = {
	status:
		| "pending"
		| "traces_cleaned"
		| "clickhouse_cleaned"
		| "failed"
		| "completed";
	traces_cleaned_at: Date | null;
	observations_cleaned_at: Date | null;
	completed_at: Date | null;
	attempt_count: number;
};
const deletionStatus = (job: DeletionJob) => ({
	status: job.status,
	traces_cleaned_at: job.traces_cleaned_at?.toISOString() ?? null,
	observations_cleaned_at: job.observations_cleaned_at?.toISOString() ?? null,
	completed_at: job.completed_at?.toISOString() ?? null,
	attempt_count: job.attempt_count,
});
const deletionCleanupSql = [
	"DELETE FROM prompt_optimization_events WHERE job_id IN (SELECT id FROM prompt_optimization_jobs WHERE project_id = $1)",
	"DELETE FROM prompt_optimization_jobs WHERE project_id = $1",
	"DELETE FROM prompt_tombstones WHERE project_id = $1",
	"DELETE FROM prompt_deletion_audit WHERE project_id = $1",
	"DELETE FROM prompt_label_quarantine WHERE original_project_id = $1",
	"DELETE FROM prompt_labels WHERE project_id = $1",
	"DELETE FROM prompts WHERE project_id = $1",
	"DELETE FROM benchmark_runs WHERE project_id = $1",
	"DELETE FROM benchmark_suites WHERE project_id = $1",
	"DELETE FROM feedback_idempotency WHERE project_id = $1",
	"DELETE FROM feedback_reviews WHERE project_id = $1",
	"DELETE FROM experiment_tasks WHERE experiment_id IN (SELECT id FROM experiments WHERE project_id = $1)",
	"DELETE FROM experiment_results WHERE experiment_id IN (SELECT id FROM experiments WHERE project_id = $1)",
	"DELETE FROM experiments WHERE project_id = $1",
	"DELETE FROM dataset_items WHERE dataset_id IN (SELECT id FROM datasets WHERE project_id = $1)",
	"DELETE FROM scores WHERE project_id = $1",
	"DELETE FROM datasets WHERE project_id = $1",
	"DELETE FROM agents WHERE project_id = $1",
	"DELETE FROM governance_retention_previews WHERE project_id = $1",
	"DELETE FROM governance_retention_runs WHERE project_id = $1",
	"DELETE FROM governance_policy_approvals WHERE project_id = $1",
	"DELETE FROM governance_policy_versions WHERE project_id = $1",
	"DELETE FROM governance_policies WHERE project_id = $1",
	"DELETE FROM project_memberships WHERE project_id = $1",
];
function failure(c: Context, error: unknown): Response {
	const message =
		error instanceof Error ? error.message : "Project operation failed";
	const code =
		typeof error === "object" && error !== null && "code" in error
			? (error as { code?: string }).code
			: undefined;
	if (code === "23505")
		return c.json(
			{ code: "CONFLICT", message: "Project slug is already in use" },
			409,
		);
	if (code === "23503")
		return c.json(
			{
				code: "CONFLICT",
				message: "Organization member has project memberships",
			},
			409,
		);
	if (
		message.includes("final") ||
		message.includes("cannot restore") ||
		message.includes("Default project") ||
		message.includes("default project") ||
		message.includes("Confirmation name") ||
		message.includes("deletion is incomplete")
	)
		return c.json({ code: "CONFLICT", message }, 409);
	if (message === "Forbidden")
		return c.json({ code: "FORBIDDEN", message }, 403);
	if (message === "Not found")
		return c.json(
			{ code: "NOT_FOUND", message: "Project is not available" },
			404,
		);
	return c.json({ code: "INTERNAL", message: "Project operation failed" }, 500);
}
async function requireProjectPolicy(
	c: Context,
	projectId: string,
	operation: ProjectOperation,
) {
	try {
		await assertTenantProjectAccess(
			pgPool(),
			trustedTenant(c),
			projectId,
			operation,
		);
	} catch (cause) {
		if (cause instanceof TenantScopeError) throw new Error("Not found");
		throw cause;
	}
}
async function requireOrganizationPolicy(
	c: Context,
	operation: "organization_manage" | "destructive" | "governed",
) {
	try {
		await assertOrganizationAccess(pgPool(), trustedTenant(c), operation);
	} catch (cause) {
		if (cause instanceof TenantScopeError) throw new Error("Forbidden");
		throw cause;
	}
}
async function role(
	c: Context,
	projectId?: string,
	manager = false,
	owner = false,
) {
	const tenant = trustedTenant(c);
	const pool = pgPool();
	const result = projectId
		? await pool.query<{ role: string | null }>(
				"SELECT CASE WHEN om.role = 'owner' THEN 'owner' ELSE pm.role END AS role FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id JOIN actor_identities identity ON identity.actor_id = $3 AND identity.organization_id = p.organization_id AND identity.provider_namespace = 'basic:v1' AND identity.canonical_subject = basic_auth_canonical_subject(om.actor_subject) LEFT JOIN project_memberships pm ON pm.project_id = p.id AND basic_auth_canonical_subject(pm.actor_subject) = identity.canonical_subject WHERE p.id = $1 AND p.organization_id = $2",
				[projectId, tenant.organizationId, tenant.actorId],
			)
		: await pool.query<{ role: string }>(
				"SELECT om.role FROM organization_memberships om JOIN actor_identities identity ON identity.actor_id = $2 AND identity.organization_id = om.organization_id AND identity.provider_namespace = 'basic:v1' AND identity.canonical_subject = basic_auth_canonical_subject(om.actor_subject) WHERE om.organization_id = $1",
				[tenant.organizationId, tenant.actorId],
			);
	const value = result.rows[0]?.role;
	if (!value) throw new Error("Not found");
	if (owner && value !== "owner") throw new Error("Forbidden");
	if (manager && value !== "manager" && value !== "owner")
		throw new Error("Forbidden");
	return { ...tenant, projectRole: value as "owner" | "manager" | "member" };
}
export async function handleGetMe(c: Context) {
	try {
		const tenant = trustedTenant(c);
		const pool = pgPool();
		const membership = await pool.query<{
			role: "owner" | "member";
			default_project_id: string;
		}>(
			"SELECT om.role, o.default_project_id FROM organization_memberships om JOIN organizations o ON o.id = om.organization_id JOIN actor_identities identity ON identity.actor_id = $2 AND identity.organization_id = om.organization_id AND identity.provider_namespace = 'basic:v1' AND identity.canonical_subject = basic_auth_canonical_subject(om.actor_subject) WHERE om.organization_id = $1",
			[tenant.organizationId, tenant.actorId],
		);
		if (!membership.rows[0]) throw new Error("Not found");
		const rows = await listAccessibleProjects(pool, tenant, false);
		return c.json({
			actor_subject: tenant.actor,
			actor_id: tenant.actorId,
			organization_id: tenant.organizationId,
			organization_role: publicOrganizationRole(membership.rows[0].role),
			effective_organization_role_id: `organization:${publicOrganizationRole(membership.rows[0].role)}`,
			default_project_id: membership.rows[0].default_project_id,
			projects: rows.rows.map(project),
		});
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleListProjects(c: Context) {
	try {
		const tenant = trustedTenant(c);
		const membership = await pgPool().query(
			"SELECT om.role FROM organization_memberships om JOIN actor_identities identity ON identity.actor_id = $2 AND identity.organization_id = om.organization_id AND identity.provider_namespace = 'basic:v1' AND identity.canonical_subject = basic_auth_canonical_subject(om.actor_subject) WHERE om.organization_id = $1",
			[tenant.organizationId, tenant.actorId],
		);
		if (!membership.rows[0]) throw new Error("Not found");
		const includeArchived =
			(c.req as any).valid("query").include_archived === "true";
		const rows = await listAccessibleProjects(
			pgPool(),
			tenant,
			includeArchived,
		);
		const items = rows.rows.map(project);
		return c.json({ items, total: items.length });
	} catch (error) {
		return failure(c, error);
	}
}

async function listAccessibleProjects(
	pool: ReturnType<typeof pgPool>,
	tenant: ReturnType<typeof trustedTenant>,
	includeArchived: boolean,
) {
	return pool.query<Row>(
		"SELECT p.id, p.name, p.slug, p.status, p.created_at, p.archived_at, p.id = o.default_project_id AS is_default, CASE WHEN om.role = 'owner' THEN 'owner' ELSE pm.role END AS project_role FROM projects p JOIN organizations o ON o.id = p.organization_id JOIN organization_memberships om ON om.organization_id = p.organization_id JOIN actor_identities identity ON identity.actor_id = $3 AND identity.organization_id = p.organization_id AND identity.provider_namespace = 'basic:v1' AND identity.canonical_subject = basic_auth_canonical_subject(om.actor_subject) LEFT JOIN project_memberships pm ON pm.project_id = p.id AND basic_auth_canonical_subject(pm.actor_subject) = identity.canonical_subject WHERE p.organization_id = $1 AND (om.role = 'owner' OR pm.actor_subject IS NOT NULL) AND (p.status = 'active' OR ($2::boolean AND authorization_allows_project(p.organization_id, p.id, $3, 'project_manage'))) ORDER BY p.created_at",
		[tenant.organizationId, includeArchived, tenant.actorId],
	);
}

async function queryWithProjectAuditLock<T extends QueryResultRow>(
	projectId: string,
	sql: string,
	values: unknown[],
) {
	const client = await pgPool().connect();
	try {
		await client.query("BEGIN");
		await client.query("SELECT lock_project_audit_provenance($1::uuid)", [
			projectId,
		]);
		const result = await client.query<T>(sql, values);
		await client.query("COMMIT");
		return result;
	} catch (cause) {
		await client.query("ROLLBACK").catch(() => {});
		throw cause;
	} finally {
		client.release();
	}
}

async function queryWithOrganizationAuditLocks<T extends QueryResultRow>(
	organizationId: string,
	sql: string,
	values: unknown[],
) {
	const client = await pgPool().connect();
	try {
		await client.query("BEGIN");
		const projects = await client.query<{ id: string }>(
			"SELECT id FROM projects WHERE organization_id = $1 ORDER BY id",
			[organizationId],
		);
		await client.query(
			"SELECT lock_project_audit_provenance(id::uuid) FROM unnest($1::uuid[]) AS projects(id) ORDER BY id",
			[projects.rows.map((project) => project.id)],
		);
		const result = await client.query<T>(sql, values);
		await client.query("COMMIT");
		return result;
	} catch (cause) {
		await client.query("ROLLBACK").catch(() => {});
		throw cause;
	} finally {
		client.release();
	}
}
export async function handleCreateProject(c: Context) {
	try {
		await requireOrganizationPolicy(c, "organization_manage");
		const tenant = trustedTenant(c);
		const input = (c.req as any).valid("json");
		const row = await pgPool().query<Row>(
			"WITH authorization AS MATERIALIZED (SELECT 1 FROM organization_memberships WHERE organization_id = $3 AND basic_auth_identity_matches($3, actor_subject, $5) AND role = 'owner' AND authorization_allows_organization($3, $5, 'organization_manage') FOR UPDATE), p AS (INSERT INTO projects (name, slug, organization_id) SELECT $1, $2, $3 FROM authorization RETURNING id, name, slug, status, created_at, archived_at), m AS (INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) SELECT id, $3, $4, 'manager' FROM p), audit AS (INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $3, id, $4, 'project_created' FROM p), lifecycle AS (INSERT INTO project_lifecycle_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $3, id, $4, 'project_created' FROM p) SELECT * FROM p",
			[
				input.name,
				input.slug,
				tenant.organizationId,
				tenant.actor,
				tenant.actorId,
			],
		);
		const value = row.rows[0];
		if (!value) throw new Error("Forbidden");
		return c.json(
			project({ ...value, project_role: "owner", is_default: false }),
			201,
		);
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleSetDefaultProject(c: Context) {
	try {
		await requireOrganizationPolicy(c, "destructive");
		const tenant = trustedTenant(c);
		const { project_id } = (c.req as any).valid("json");
		const client = await pgPool().connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT lock_project_audit_provenance($1::uuid)", [
				project_id,
			]);
			const updated = await client.query<Row>(
				"WITH authorization AS MATERIALIZED (SELECT 1 FROM organization_memberships WHERE organization_id = $1 AND basic_auth_identity_matches($1, actor_subject, $4) AND role = 'owner' AND authorization_allows_organization($1, $4, 'destructive') FOR UPDATE), selected AS MATERIALIZED (SELECT p.id FROM projects p WHERE p.id = $2 AND p.organization_id = $1 AND p.status = 'active' FOR UPDATE), changed AS (UPDATE organizations SET default_project_id = $2, updated_at = now() WHERE id = $1 AND EXISTS (SELECT 1 FROM authorization) AND EXISTS (SELECT 1 FROM selected) RETURNING id), audit AS (INSERT INTO project_lifecycle_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $1, $2, $3, 'default_changed' FROM changed) SELECT p.id, p.name, p.slug, p.status, p.created_at, p.archived_at, true AS is_default, 'owner'::text AS project_role FROM projects p WHERE p.id = $2 AND EXISTS (SELECT 1 FROM changed)",
				[tenant.organizationId, project_id, tenant.actor, tenant.actorId],
			);
			if (!updated.rows[0]) throw new Error("Not found");
			await client.query("COMMIT");
			return c.json(project(updated.rows[0]));
		} catch (cause) {
			await client.query("ROLLBACK");
			throw cause;
		} finally {
			client.release();
		}
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleDeleteProject(c: Context) {
	try {
		const id = (c.req as any).valid("param").id;
		await requireProjectPolicy(c, id, "destructive");
		const { confirmation_name } = (c.req as any).valid("json");
		const tenant = trustedTenant(c);
		const pool = pgPool();
		const client = await pool.connect();
		let job: DeletionJob;
		try {
			await client.query("BEGIN");
			await client.query("SELECT lock_project_audit_provenance($1::uuid)", [
				id,
			]);
			const target = await client.query<{
				name: string;
				status: Row["status"];
			}>(
				"SELECT p.name, p.status FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND basic_auth_identity_matches(p.organization_id, om.actor_subject, $3) LEFT JOIN project_memberships pm ON pm.project_id = p.id AND basic_auth_identity_matches(p.organization_id, pm.actor_subject, $3) WHERE p.id = $1 AND p.organization_id = $2 AND ((p.status = 'deleting' AND (om.role = 'owner' OR pm.role = 'manager')) OR (p.status <> 'deleting' AND om.role = 'owner')) AND authorization_allows_project($2, $1, $3, 'destructive') FOR UPDATE OF p, om",
				[id, tenant.organizationId, tenant.actorId],
			);
			if (!target.rows[0]) throw new Error("Not found");
			if (target.rows[0].name !== confirmation_name)
				throw new Error("Confirmation name does not match this project");
			const organization = await client.query<{ default_project_id: string }>(
				"SELECT default_project_id FROM organizations WHERE id = $1 FOR UPDATE",
				[tenant.organizationId],
			);
			if (organization.rows[0]?.default_project_id === id)
				throw new Error("Default project cannot be deleted");
			if (target.rows[0].status === "archived")
				throw new Error("Archived project cannot be permanently deleted");
			await client.query(
				"UPDATE projects SET status = 'deleting', updated_at = now() WHERE id = $1 AND organization_id = $2",
				[id, tenant.organizationId],
			);
			const created = await client.query<DeletionJob>(
				"INSERT INTO project_deletion_jobs (organization_id, project_id, requested_by, status, attempt_count) VALUES ($1, $2, $3, 'pending', 1) ON CONFLICT (organization_id, project_id) DO UPDATE SET requested_by = EXCLUDED.requested_by, attempt_count = project_deletion_jobs.attempt_count + 1, updated_at = now() RETURNING status, traces_cleaned_at, observations_cleaned_at, completed_at, attempt_count",
				[tenant.organizationId, id, tenant.actor],
			);
			job = created.rows[0]!;
			await client.query(
				"INSERT INTO project_lifecycle_audit_events (organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'deletion_attempted')",
				[tenant.organizationId, id, tenant.actor],
			);
			await client.query("COMMIT");
		} catch (cause) {
			await client.query("ROLLBACK");
			throw cause;
		} finally {
			client.release();
		}
		try {
			if (!job.traces_cleaned_at) {
				await ch().command({
					query:
						"ALTER TABLE traces DELETE WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} SETTINGS mutations_sync = 1",
					query_params: {
						organizationId: tenant.organizationId,
						projectId: id,
					},
				});
				await pool.query(
					"UPDATE project_deletion_jobs SET status = 'traces_cleaned', traces_cleaned_at = now(), updated_at = now() WHERE organization_id = $1 AND project_id = $2 AND traces_cleaned_at IS NULL",
					[tenant.organizationId, id],
				);
			}
			if (!job.observations_cleaned_at) {
				await ch().command({
					query:
						"ALTER TABLE observations DELETE WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} SETTINGS mutations_sync = 1",
					query_params: {
						organizationId: tenant.organizationId,
						projectId: id,
					},
				});
				await pool.query(
					"UPDATE project_deletion_jobs SET status = 'clickhouse_cleaned', observations_cleaned_at = now(), updated_at = now() WHERE organization_id = $1 AND project_id = $2 AND observations_cleaned_at IS NULL",
					[tenant.organizationId, id],
				);
			}
			const finalize = await pool.connect();
			try {
				await finalize.query("BEGIN");
				await finalize.query("SELECT lock_project_audit_provenance($1::uuid)", [
					id,
				]);
				await finalize.query(
					"SELECT set_config('astraea.project_deletion_id', $1, true)",
					[id],
				);
				for (const sql of deletionCleanupSql) await finalize.query(sql, [id]);
				const deleted = await finalize.query(
					"DELETE FROM projects WHERE id = $1 AND organization_id = $2 AND status = 'deleting'",
					[id, tenant.organizationId],
				);
				if (!deleted.rowCount) throw new Error("Not found");
				await finalize.query(
					"UPDATE project_deletion_jobs SET status = 'completed', completed_at = now(), updated_at = now() WHERE organization_id = $1 AND project_id = $2",
					[tenant.organizationId, id],
				);
				await finalize.query(
					"INSERT INTO project_lifecycle_audit_events (organization_id, project_id, actor_subject, event_type, result) VALUES ($1, $2, $3, 'deletion_completed', '{\"stage\":\"completed\"}')",
					[tenant.organizationId, id, tenant.actor],
				);
				await finalize.query("COMMIT");
			} catch (cause) {
				await finalize.query("ROLLBACK");
				throw cause;
			} finally {
				finalize.release();
			}
			return c.body(null, 204);
		} catch {
			await pool.query(
				"UPDATE project_deletion_jobs SET status = 'failed', updated_at = now() WHERE organization_id = $1 AND project_id = $2 AND status <> 'completed'",
				[tenant.organizationId, id],
			);
			await pool.query(
				"INSERT INTO project_lifecycle_audit_events (organization_id, project_id, actor_subject, event_type, result) VALUES ($1, $2, $3, 'deletion_failed', '{\"stage\":\"retry_required\"}')",
				[tenant.organizationId, id, tenant.actor],
			);
			throw new Error(
				"Project deletion is incomplete; retry the deletion request",
			);
		}
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleGetProjectDeletionStatus(c: Context) {
	try {
		const id = (c.req as any).valid("param").id;
		await requireProjectPolicy(c, id, "destructive");
		const tenant = trustedTenant(c);
		const result = await pgPool().query<DeletionJob>(
			"SELECT j.status, j.traces_cleaned_at, j.observations_cleaned_at, j.completed_at, j.attempt_count FROM project_deletion_jobs j JOIN projects p ON p.id = j.project_id AND p.organization_id = j.organization_id JOIN organization_memberships om ON om.organization_id = p.organization_id AND basic_auth_identity_matches(p.organization_id, om.actor_subject, $3) LEFT JOIN project_memberships pm ON pm.project_id = p.id AND basic_auth_identity_matches(p.organization_id, pm.actor_subject, $3) WHERE j.project_id = $1 AND j.organization_id = $2 AND p.status = 'deleting' AND (om.role = 'owner' OR pm.role = 'manager')",
			[id, tenant.organizationId, tenant.actorId],
		);
		if (!result.rows[0]) throw new Error("Not found");
		return c.json(deletionStatus(result.rows[0]));
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleGetProject(c: Context) {
	try {
		const params = (c.req as any).valid("param");
		await requireProjectPolicy(c, params.id, "product_read");
		const tenant = await role(c, params.id);
		const rows = await pgPool().query<Row>(
			"SELECT p.id, p.name, p.slug, p.status, p.created_at, p.archived_at, p.id = o.default_project_id AS is_default, CASE WHEN om.role = 'owner' THEN 'owner' ELSE pm.role END AS project_role FROM projects p JOIN organizations o ON o.id = p.organization_id JOIN organization_memberships om ON om.organization_id = p.organization_id AND basic_auth_identity_matches(p.organization_id, om.actor_subject, $3) LEFT JOIN project_memberships pm ON pm.project_id = p.id AND basic_auth_identity_matches(p.organization_id, pm.actor_subject, $3) WHERE p.id = $1 AND p.organization_id = $2 AND (om.role = 'owner' OR pm.actor_subject IS NOT NULL)",
			[params.id, tenant.organizationId, tenant.actorId],
		);
		if (!rows.rows[0]) throw new Error("Not found");
		return c.json(project(rows.rows[0]));
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleUpdateProject(c: Context) {
	try {
		const id = (c.req as any).valid("param").id;
		await requireProjectPolicy(c, id, "project_manage");
		const tenant = trustedTenant(c);
		const input = (c.req as any).valid("json");
		const rows = await queryWithProjectAuditLock<Row>(
			id,
			"WITH authorization AS MATERIALIZED (SELECT p.id, CASE WHEN om.role = 'owner' THEN 'owner' ELSE pm.role END AS project_role FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND basic_auth_identity_matches(p.organization_id, om.actor_subject, $6) LEFT JOIN LATERAL (SELECT role FROM project_memberships WHERE project_id = p.id AND basic_auth_identity_matches(p.organization_id, actor_subject, $6) FOR UPDATE) pm ON true WHERE p.id = $3 AND p.organization_id = $4 AND p.status <> 'deleting' AND (om.role = 'owner' OR pm.role = 'manager') AND authorization_allows_project($4, $3, $6, 'project_manage') FOR UPDATE OF p, om), p AS (UPDATE projects SET name = COALESCE($1, name), slug = COALESCE($2, slug), updated_at = now() FROM authorization WHERE projects.id = authorization.id RETURNING projects.id, projects.name, projects.slug, projects.status, projects.created_at, projects.archived_at), audit AS (INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $4, id, $5, 'project_updated' FROM p) SELECT p.*, authorization.project_role, p.id = o.default_project_id AS is_default FROM p JOIN authorization ON true JOIN organizations o ON o.id = $4",
			[
				input.name ?? null,
				input.slug ?? null,
				id,
				tenant.organizationId,
				tenant.actor,
				tenant.actorId,
			],
		);
		if (!rows.rows[0]) throw new Error("Not found");
		return c.json(project(rows.rows[0]));
	} catch (error) {
		return failure(c, error);
	}
}
async function serializedLifecycle(c: Context, status: "active" | "archived") {
	try {
		const id = (c.req as any).valid("param").id;
		await requireProjectPolicy(c, id, "project_manage");
		const tenant = trustedTenant(c);
		const client = await pgPool().connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT lock_project_audit_provenance($1::uuid)", [
				id,
			]);
			const authorized = await client.query<{
				project_role: Row["project_role"];
			}>(
				"SELECT CASE WHEN om.role = 'owner' THEN 'owner' ELSE pm.role END AS project_role FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND basic_auth_identity_matches(p.organization_id, om.actor_subject, $2) LEFT JOIN LATERAL (SELECT role FROM project_memberships WHERE project_id = p.id AND basic_auth_identity_matches(p.organization_id, actor_subject, $2) FOR UPDATE) pm ON true WHERE p.id = $1 AND p.organization_id = $3 AND p.status <> 'deleting' AND (om.role = 'owner' OR pm.role = 'manager') AND authorization_allows_project($3, $1, $2, 'project_manage') FOR UPDATE OF p, om",
				[id, tenant.actorId, tenant.organizationId],
			);
			if (!authorized.rows[0]) throw new Error("Not found");
			const rows = await client.query<Row>(
				"UPDATE projects SET status = $1, archived_at = CASE WHEN $1 = 'archived' THEN now() ELSE NULL END, archived_by = CASE WHEN $1 = 'archived' THEN $2 ELSE NULL END, updated_at = now() WHERE id = $3 RETURNING id, name, slug, status, created_at, archived_at",
				[status, tenant.actor, id],
			);
			if (status === "archived") {
				await client.query(
					"WITH failed AS (UPDATE governance_retention_runs SET status = 'failed', completed_at = now(), lease_expires_at = NULL WHERE project_id = $1 AND status = 'running' RETURNING organization_id, project_id, policy_version_id, requested_by, counts, started_at), audit AS (INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type, counts, duration_ms) SELECT organization_id, project_id, policy_version_id, requested_by, 'retention_failed', counts, GREATEST(0, round(EXTRACT(epoch FROM now() - started_at) * 1000)::integer) FROM failed) SELECT 1",
					[id],
				);
				await client.query(
					"UPDATE experiments SET status = 'cancelled', updated_at = now() WHERE project_id = $1 AND status IN ('pending', 'running')",
					[id],
				);
				await client.query(
					"UPDATE experiment_tasks SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = now() WHERE experiment_id IN (SELECT id FROM experiments WHERE project_id = $1) AND status IN ('pending', 'running')",
					[id],
				);
				const stopped = await client.query(
					"UPDATE prompt_optimization_jobs SET status = 'stopped', cancel_requested_at = now(), updated_at = now(), completed_at = now() WHERE project_id = $1 AND status IN ('queued', 'preparing', 'optimizing', 'evaluating') RETURNING id",
					[id],
				);
				for (const job of stopped.rows)
					await client.query(
						"INSERT INTO prompt_optimization_events (job_id, status) VALUES ($1, 'stopped')",
						[job.id],
					);
			}
			await client.query(
				"INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, $4)",
				[
					tenant.organizationId,
					id,
					tenant.actor,
					status === "active" ? "project_restored" : "project_archived",
				],
			);
			await client.query("COMMIT");
			if (!rows.rows[0]) throw new Error("Not found");
			return c.json(
				project({
					...rows.rows[0],
					project_role: authorized.rows[0].project_role,
				}),
			);
		} catch (cause) {
			await client.query("ROLLBACK");
			throw cause;
		} finally {
			client.release();
		}
	} catch (error) {
		return failure(c, error);
	}
}
export const handleArchiveProject = (c: Context) =>
	serializedLifecycle(c, "archived");
export const handleRestoreProject = (c: Context) =>
	serializedLifecycle(c, "active");
export async function handleListProjectMembers(c: Context) {
	try {
		const id = (c.req as any).valid("param").id;
		await requireProjectPolicy(c, id, "project_manage");
		const tenant = trustedTenant(c);
		const rows = await pgPool().query<{
			actor_subject: string;
			role: "manager" | "member";
			created_at: Date;
		}>(
			"SELECT pm.actor_subject, pm.role, pm.created_at FROM project_memberships pm WHERE pm.project_id = $1 AND EXISTS (SELECT 1 FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND basic_auth_identity_matches(p.organization_id, om.actor_subject, $2) LEFT JOIN project_memberships actor_pm ON actor_pm.project_id = p.id AND basic_auth_identity_matches(p.organization_id, actor_pm.actor_subject, $2) WHERE p.id = $1 AND p.organization_id = $3 AND (om.role = 'owner' OR actor_pm.role = 'manager')) ORDER BY pm.actor_subject",
			[id, tenant.actorId, tenant.organizationId],
		);
		return c.json({
			items: rows.rows.map((row) => ({
				...row,
				role: publicProjectRole(row.role),
				created_at: row.created_at.toISOString(),
			})),
		});
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleGetProjectAuditEvents(c: Context) {
	try {
		const id = (c.req as any).valid("param").id;
		await requireProjectPolicy(c, id, "audit_read");
		const tenant = trustedTenant(c);
		const rows = await pgPool().query<{
			id: string;
			actor_subject: string;
			event_type: string;
			created_at: Date;
		}>(
			"SELECT e.id, e.actor_subject, e.event_type, e.created_at FROM project_authorization_audit_events e WHERE e.project_id = $1 AND e.organization_id = $3 AND authorization_allows_project($3, $1, $2, 'audit_read') ORDER BY e.created_at, e.id",
			[id, tenant.actorId, tenant.organizationId],
		);
		return c.json({
			items: rows.rows.map((row) => ({
				...row,
				created_at: row.created_at.toISOString(),
			})),
		});
	} catch (error) {
		return failure(c, error);
	}
}
export async function handlePutProjectMember(c: Context) {
	try {
		const params = (c.req as any).valid("param");
		const { id } = params;
		await requireProjectPolicy(c, id, "project_manage");
		const input = (c.req as any).valid("json");
		const tenant = trustedTenant(c);
		if (input.actor_subject !== params.actor) throw new Error("Not found");
		const targetRole = legacyProjectRole(input.role);
		const member = await queryWithProjectAuditLock<{
			actor_subject: string;
			role: "manager" | "member";
			created_at: Date;
		}>(
			id,
			"WITH authorization AS MATERIALIZED (SELECT p.id FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND basic_auth_identity_matches(p.organization_id, om.actor_subject, $6) LEFT JOIN LATERAL (SELECT role FROM project_memberships WHERE project_id = p.id AND basic_auth_identity_matches(p.organization_id, actor_subject, $6) FOR UPDATE) pm ON true WHERE p.id = $1 AND p.organization_id = $2 AND p.status <> 'deleting' AND (om.role = 'owner' OR pm.role = 'manager') AND authorization_allows_project($2, $1, $6, 'project_manage') FOR UPDATE OF p, om), mutation AS (INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) SELECT $1, $2, $3, $4 FROM authorization WHERE EXISTS (SELECT 1 FROM organization_memberships WHERE organization_id = $2 AND actor_subject = $3) ON CONFLICT (project_id, actor_subject) DO UPDATE SET role = EXCLUDED.role, updated_at = now() WHERE project_memberships.role IS DISTINCT FROM EXCLUDED.role RETURNING actor_subject, role, created_at, (xmax = 0) AS created), membership AS (SELECT actor_subject, role, created_at FROM mutation UNION ALL SELECT pm.actor_subject, pm.role, pm.created_at FROM project_memberships pm WHERE pm.project_id = $1 AND pm.actor_subject = $3 AND EXISTS (SELECT 1 FROM authorization) AND NOT EXISTS (SELECT 1 FROM mutation)), audit AS (INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $2, $1, $5, CASE WHEN created THEN 'project_membership_created' ELSE 'project_membership_updated' END FROM mutation) SELECT * FROM membership",
			[
				id,
				tenant.organizationId,
				input.actor_subject,
				targetRole,
				tenant.actor,
				tenant.actorId,
			],
		);
		if (!member.rows[0]) throw new Error("Not found");
		const row = member.rows[0];
		return c.json({
			...row,
			role: publicProjectRole(row.role),
			created_at: row.created_at.toISOString(),
		});
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleDeleteProjectMember(c: Context) {
	try {
		const { id, actor } = (c.req as any).valid("param");
		await requireProjectPolicy(c, id, "project_manage");
		const tenant = trustedTenant(c);
		const deleted = await queryWithProjectAuditLock(
			id,
			"WITH authorization AS MATERIALIZED (SELECT p.id FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND basic_auth_identity_matches(p.organization_id, om.actor_subject, $5) LEFT JOIN LATERAL (SELECT role FROM project_memberships WHERE project_id = p.id AND basic_auth_identity_matches(p.organization_id, actor_subject, $5) FOR UPDATE) pm ON true WHERE p.id = $1 AND p.organization_id = $3 AND p.status <> 'deleting' AND (om.role = 'owner' OR pm.role = 'manager') AND authorization_allows_project($3, $1, $5, 'project_manage') FOR UPDATE OF p, om), deleted AS (DELETE FROM project_memberships WHERE project_id = $1 AND actor_subject = $2 AND EXISTS (SELECT 1 FROM authorization) RETURNING project_id), audit AS (INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $3, project_id, $4, 'project_membership_removed' FROM deleted) SELECT * FROM deleted",
			[id, actor, tenant.organizationId, tenant.actor, tenant.actorId],
		);
		if (!deleted.rows[0]) throw new Error("Not found");
		return c.body(null, 204);
	} catch (error) {
		return failure(c, error);
	}
}
export async function handlePutOrganizationMember(c: Context) {
	try {
		await requireOrganizationPolicy(c, "organization_manage");
		const tenant = trustedTenant(c);
		const { actor } = (c.req as any).valid("param");
		const input = (c.req as any).valid("json");
		if (actor !== input.actor_subject) throw new Error("Not found");
		const targetRole = legacyOrganizationRole(input.role);
		const row = await queryWithOrganizationAuditLocks<{
			actor_subject: string;
			role: "owner" | "member";
			created_at: Date;
		}>(
			tenant.organizationId,
			"WITH authorization AS MATERIALIZED (SELECT 1 FROM organization_memberships WHERE organization_id = $1 AND basic_auth_identity_matches($1, actor_subject, $5) AND role = 'owner' AND authorization_allows_organization($1, $5, 'organization_manage') FOR UPDATE), locked_projects AS MATERIALIZED (SELECT id, status, slug, created_at FROM projects WHERE organization_id = $1 FOR UPDATE), unfrozen AS MATERIALIZED (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM locked_projects WHERE status = 'deleting')), audit_project AS MATERIALIZED (SELECT id FROM locked_projects ORDER BY (slug = 'default') DESC, created_at, id LIMIT 1), mutation AS (INSERT INTO organization_memberships (organization_id, actor_subject, role) SELECT $1, $2, $3 FROM authorization CROSS JOIN unfrozen WHERE EXISTS (SELECT 1 FROM locked_projects) ON CONFLICT (organization_id, actor_subject) DO UPDATE SET role = EXCLUDED.role, updated_at = now() WHERE organization_memberships.role IS DISTINCT FROM EXCLUDED.role RETURNING actor_subject, role, created_at, (xmax = 0) AS created), membership AS (SELECT actor_subject, role, created_at FROM mutation UNION ALL SELECT om.actor_subject, om.role, om.created_at FROM organization_memberships om WHERE om.organization_id = $1 AND om.actor_subject = $2 AND EXISTS (SELECT 1 FROM authorization) AND EXISTS (SELECT 1 FROM locked_projects) AND EXISTS (SELECT 1 FROM unfrozen) AND NOT EXISTS (SELECT 1 FROM mutation)), audit AS (INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $1, audit_project.id, $4, CASE WHEN created THEN 'organization_membership_created' ELSE 'organization_membership_updated' END FROM mutation CROSS JOIN audit_project) SELECT * FROM membership",
			[tenant.organizationId, actor, targetRole, tenant.actor, tenant.actorId],
		);
		const value = row.rows[0];
		if (!value) throw new Error("Forbidden");
		return c.json({
			...value,
			role: publicOrganizationRole(value.role),
			created_at: value.created_at.toISOString(),
		});
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleListOrganizationMembers(c: Context) {
	try {
		await requireOrganizationPolicy(c, "organization_manage");
		const tenant = trustedTenant(c);
		const rows = await pgPool().query<{
			actor_subject: string;
			role: "owner" | "member";
			created_at: Date;
		}>(
			"SELECT om.actor_subject, om.role, om.created_at FROM organization_memberships om WHERE om.organization_id = $1 AND EXISTS (SELECT 1 FROM organization_memberships actor_om WHERE actor_om.organization_id = $1 AND basic_auth_identity_matches($1, actor_om.actor_subject, $2) AND actor_om.role = 'owner') ORDER BY om.actor_subject",
			[tenant.organizationId, tenant.actorId],
		);
		return c.json({
			items: rows.rows.map((row) => ({
				...row,
				role: publicOrganizationRole(row.role),
				created_at: row.created_at.toISOString(),
			})),
		});
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleDeleteOrganizationMember(c: Context) {
	try {
		await requireOrganizationPolicy(c, "organization_manage");
		const tenant = trustedTenant(c);
		const { actor } = (c.req as any).valid("param");
		const deleted = await queryWithOrganizationAuditLocks(
			tenant.organizationId,
			"WITH authorization AS MATERIALIZED (SELECT 1 FROM organization_memberships WHERE organization_id = $1 AND basic_auth_identity_matches($1, actor_subject, $4) AND role = 'owner' AND authorization_allows_organization($1, $4, 'organization_manage') FOR UPDATE), locked_projects AS MATERIALIZED (SELECT id, status, slug, created_at FROM projects WHERE organization_id = $1 FOR UPDATE), unfrozen AS MATERIALIZED (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM locked_projects WHERE status = 'deleting')), audit_project AS MATERIALIZED (SELECT id FROM locked_projects ORDER BY (slug = 'default') DESC, created_at, id LIMIT 1), deleted AS (DELETE FROM organization_memberships WHERE organization_id = $1 AND actor_subject = $2 AND EXISTS (SELECT 1 FROM authorization) AND EXISTS (SELECT 1 FROM locked_projects) AND EXISTS (SELECT 1 FROM unfrozen) RETURNING actor_subject), audit AS (INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $1, audit_project.id, $3, 'organization_membership_removed' FROM deleted CROSS JOIN audit_project) SELECT * FROM deleted",
			[tenant.organizationId, actor, tenant.actor, tenant.actorId],
		);
		if (!deleted.rows[0]) throw new Error("Forbidden");
		return c.body(null, 204);
	} catch (error) {
		return failure(c, error);
	}
}
