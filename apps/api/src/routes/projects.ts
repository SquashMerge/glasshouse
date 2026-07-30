import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { pgPool } from "../db/postgres.js";
import { trustedTenant } from "../tenancy.js";
import {
	CreateProjectInput,
	Me,
	MemberInput,
	OrganizationMember,
	OrganizationMemberInput,
	ProjectAuditEvent,
	Project,
	ProjectErrorResponses,
	ProjectList,
	ListProjectsQuery,
	ProjectMember,
	UpdateProjectInput,
} from "../schemas/projects.js";

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
	status: "active" | "archived";
	created_at: Date;
	archived_at: Date | null;
	project_role: "owner" | "manager" | "member";
};
const project = (row: Row) => ({
	...row,
	created_at: row.created_at.toISOString(),
	archived_at: row.archived_at?.toISOString() ?? null,
});
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
	if (message.includes("final") || message.includes("cannot restore"))
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
				"SELECT CASE WHEN om.role = 'owner' THEN 'owner' ELSE pm.role END AS role FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND om.actor_subject = $3 LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.actor_subject = $3 WHERE p.id = $1 AND p.organization_id = $2",
				[projectId, tenant.organizationId, tenant.actor],
			)
		: await pool.query<{ role: string }>(
				"SELECT role FROM organization_memberships WHERE organization_id = $1 AND actor_subject = $2",
				[tenant.organizationId, tenant.actor],
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
		const membership = await pool.query<{ role: "owner" | "member" }>(
			"SELECT role FROM organization_memberships WHERE organization_id = $1 AND actor_subject = $2",
			[tenant.organizationId, tenant.actor],
		);
		if (!membership.rows[0]) throw new Error("Not found");
		const rows = await listAccessibleProjects(pool, tenant, false);
		return c.json({
			actor_subject: tenant.actor,
			organization_id: tenant.organizationId,
			organization_role: membership.rows[0].role,
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
			"SELECT role FROM organization_memberships WHERE organization_id = $1 AND actor_subject = $2",
			[tenant.organizationId, tenant.actor],
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
		"SELECT p.id, p.name, p.slug, p.status, p.created_at, p.archived_at, CASE WHEN om.role = 'owner' THEN 'owner' ELSE pm.role END AS project_role FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND om.actor_subject = $2 LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.actor_subject = $2 WHERE p.organization_id = $1 AND (om.role = 'owner' OR pm.actor_subject IS NOT NULL) AND (p.status = 'active' OR ($3::boolean AND CASE WHEN om.role = 'owner' THEN 'owner' ELSE pm.role END IN ('manager', 'owner'))) ORDER BY p.created_at",
		[tenant.organizationId, tenant.actor, includeArchived],
	);
}
export async function handleCreateProject(c: Context) {
	try {
		const tenant = await role(c, undefined, false, true);
		const input = (c.req as any).valid("json");
		const row = await pgPool().query<Row>(
			"WITH p AS (INSERT INTO projects (name, slug, organization_id) VALUES ($1, $2, $3) RETURNING id, name, slug, status, created_at, archived_at), m AS (INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) SELECT id, $3, $4, 'manager' FROM p), audit AS (INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $3, id, $4, 'project_created' FROM p) SELECT * FROM p",
			[input.name, input.slug, tenant.organizationId, tenant.actor],
		);
		const value = row.rows[0];
		if (!value) throw new Error("Project operation failed");
		return c.json(project({ ...value, project_role: tenant.projectRole }), 201);
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleGetProject(c: Context) {
	try {
		const params = (c.req as any).valid("param");
		const tenant = await role(c, params.id);
		const rows = await pgPool().query<Row>(
			"SELECT p.id, p.name, p.slug, p.status, p.created_at, p.archived_at, CASE WHEN om.role = 'owner' THEN 'owner' ELSE pm.role END AS project_role FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND om.actor_subject = $3 LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.actor_subject = $3 WHERE p.id = $1 AND p.organization_id = $2",
			[params.id, tenant.organizationId, tenant.actor],
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
		const tenant = await role(c, id, true);
		const input = (c.req as any).valid("json");
		const rows = await pgPool().query<Row>(
			"WITH p AS (UPDATE projects SET name = COALESCE($1, name), slug = COALESCE($2, slug), updated_at = now() WHERE id = $3 AND organization_id = $4 RETURNING id, name, slug, status, created_at, archived_at), audit AS (INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $4, id, $5, 'project_updated' FROM p) SELECT * FROM p",
			[
				input.name ?? null,
				input.slug ?? null,
				id,
				tenant.organizationId,
				tenant.actor,
			],
		);
		if (!rows.rows[0]) throw new Error("Not found");
		return c.json(
			project({ ...rows.rows[0], project_role: tenant.projectRole }),
		);
	} catch (error) {
		return failure(c, error);
	}
}
async function lifecycle(c: Context, status: "active" | "archived") {
	try {
		const id = (c.req as any).valid("param").id;
		const tenant = await role(c, id, true);
		const rows = await pgPool().query<Row>(
			"UPDATE projects SET status = $1, archived_at = CASE WHEN $1 = 'archived' THEN now() ELSE NULL END, archived_by = CASE WHEN $1 = 'archived' THEN $2 ELSE NULL END, updated_at = now() WHERE id = $3 AND organization_id = $4 RETURNING id, name, slug, status, created_at, archived_at",
			[status, tenant.actor, id, tenant.organizationId],
		);
		if (!rows.rows[0]) throw new Error("Not found");
		await pgPool().query(
			"INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, $4)",
			[
				tenant.organizationId,
				id,
				tenant.actor,
				status === "active" ? "project_restored" : "project_archived",
			],
		);
		return c.json(
			project({ ...rows.rows[0], project_role: tenant.projectRole }),
		);
	} catch (error) {
		return failure(c, error);
	}
}
export const handleArchiveProject = (c: Context) => lifecycle(c, "archived");
export const handleRestoreProject = (c: Context) => lifecycle(c, "active");
export async function handleListProjectMembers(c: Context) {
	try {
		const id = (c.req as any).valid("param").id;
		await role(c, id, true);
		const rows = await pgPool().query<{
			actor_subject: string;
			role: "manager" | "member";
			created_at: Date;
		}>(
			"SELECT actor_subject, role, created_at FROM project_memberships WHERE project_id = $1 ORDER BY actor_subject",
			[id],
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
export async function handleGetProjectAuditEvents(c: Context) {
	try {
		const id = (c.req as any).valid("param").id;
		await role(c, id, true);
		const rows = await pgPool().query<{
			id: string;
			actor_subject: string;
			event_type: string;
			created_at: Date;
		}>(
			"SELECT id, actor_subject, event_type, created_at FROM project_authorization_audit_events WHERE project_id = $1 ORDER BY created_at, id",
			[id],
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
		const input = (c.req as any).valid("json");
		const tenant = await role(c, id, true);
		if (input.actor_subject !== params.actor) throw new Error("Not found");
		const member = await pgPool().query<{
			actor_subject: string;
			role: "manager" | "member";
			created_at: Date;
		}>(
			"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM organization_memberships WHERE organization_id = $2 AND actor_subject = $3) ON CONFLICT (project_id, actor_subject) DO UPDATE SET role = EXCLUDED.role, updated_at = now() RETURNING actor_subject, role, created_at",
			[id, tenant.organizationId, input.actor_subject, input.role],
		);
		if (!member.rows[0]) throw new Error("Not found");
		await pgPool().query(
			"INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_membership_updated')",
			[tenant.organizationId, id, tenant.actor],
		);
		const row = member.rows[0];
		return c.json({ ...row, created_at: row.created_at.toISOString() });
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleDeleteProjectMember(c: Context) {
	try {
		const { id, actor } = (c.req as any).valid("param");
		const tenant = await role(c, id, true);
		const deleted = await pgPool().query(
			"DELETE FROM project_memberships WHERE project_id = $1 AND actor_subject = $2",
			[id, actor],
		);
		if (!deleted.rowCount) throw new Error("Not found");
		await pgPool().query(
			"INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_membership_removed')",
			[tenant.organizationId, id, tenant.actor],
		);
		return c.body(null, 204);
	} catch (error) {
		return failure(c, error);
	}
}
export async function handlePutOrganizationMember(c: Context) {
	try {
		const tenant = await role(c, undefined, false, true);
		const { actor } = (c.req as any).valid("param");
		const input = (c.req as any).valid("json");
		if (actor !== input.actor_subject) throw new Error("Not found");
		const row = await pgPool().query<{
			actor_subject: string;
			role: "owner" | "member";
			created_at: Date;
		}>(
			"INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES ($1, $2, $3) ON CONFLICT (organization_id, actor_subject) DO UPDATE SET role = EXCLUDED.role, updated_at = now() RETURNING actor_subject, role, created_at",
			[tenant.organizationId, actor, input.role],
		);
		await pgPool().query(
			"INSERT INTO project_authorization_audit_events (organization_id, actor_subject, event_type) VALUES ($1, $2, 'organization_membership_updated')",
			[tenant.organizationId, tenant.actor],
		);
		const value = row.rows[0];
		if (!value) throw new Error("Not found");
		return c.json({
			...value,
			created_at: value.created_at.toISOString(),
		});
	} catch (error) {
		return failure(c, error);
	}
}
export async function handleListOrganizationMembers(c: Context) {
	try {
		const tenant = await role(c, undefined, false, true);
		const rows = await pgPool().query<{
			actor_subject: string;
			role: "owner" | "member";
			created_at: Date;
		}>(
			"SELECT actor_subject, role, created_at FROM organization_memberships WHERE organization_id = $1 ORDER BY actor_subject",
			[tenant.organizationId],
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
export async function handleDeleteOrganizationMember(c: Context) {
	try {
		const tenant = await role(c, undefined, false, true);
		const { actor } = (c.req as any).valid("param");
		const deleted = await pgPool().query(
			"DELETE FROM organization_memberships WHERE organization_id = $1 AND actor_subject = $2",
			[tenant.organizationId, actor],
		);
		if (!deleted.rowCount) throw new Error("Not found");
		await pgPool().query(
			"INSERT INTO project_authorization_audit_events (organization_id, actor_subject, event_type) VALUES ($1, $2, 'organization_membership_removed')",
			[tenant.organizationId, tenant.actor],
		);
		return c.body(null, 204);
	} catch (error) {
		return failure(c, error);
	}
}
