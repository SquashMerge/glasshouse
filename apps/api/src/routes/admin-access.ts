import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { PoolClient } from "pg";
import { basicCredentialsFromEnvironment } from "../middleware/auth.js";
import { pgPool } from "../db/postgres.js";
import {
	lockProjectAuditProvenance,
	withLockPhaseTransaction,
} from "../db/project-authorization.js";
import { assertOrganizationAccess, trustedTenant } from "../tenancy.js";
import {
	AdminAuditEvent,
	AdminActor,
	AdminErrorResponses,
	OrganizationRoleInput,
	ProjectGrant,
	ProjectGrantInput,
	RecoveryInput,
} from "../schemas/admin-access.js";

const Id = z.string().uuid();
const actorParams = z.object({ actorId: Id });
const projectParams = z.object({ projectId: Id });
const grantParams = z.object({ projectId: Id, actorId: Id });
const listResponse = (schema: z.ZodType) => ({
	200: { description: "OK", content: { "application/json": { schema } } },
	...AdminErrorResponses,
});

export const listAdminActors = createRoute({
	method: "get",
	path: "/v1/admin/actors",
	tags: ["administration"],
	security: [{ basicAuth: [] }],
	responses: listResponse(z.object({ items: z.array(AdminActor) })),
});

export const setAdminActorRole = createRoute({
	method: "put",
	path: "/v1/admin/actors/{actorId}/role",
	tags: ["administration"],
	security: [{ basicAuth: [] }],
	request: {
		params: actorParams,
		body: {
			content: { "application/json": { schema: OrganizationRoleInput } },
		},
	},
	responses: listResponse(AdminActor),
});

export const listProjectGrants = createRoute({
	method: "get",
	path: "/v1/admin/projects/{projectId}/grants",
	tags: ["administration"],
	security: [{ basicAuth: [] }],
	request: { params: projectParams },
	responses: listResponse(z.object({ items: z.array(ProjectGrant) })),
});

export const setProjectGrant = createRoute({
	method: "put",
	path: "/v1/admin/projects/{projectId}/grants/{actorId}",
	tags: ["administration"],
	security: [{ basicAuth: [] }],
	request: {
		params: grantParams,
		body: { content: { "application/json": { schema: ProjectGrantInput } } },
	},
	responses: listResponse(ProjectGrant),
});

export const revokeProjectGrant = createRoute({
	method: "delete",
	path: "/v1/admin/projects/{projectId}/grants/{actorId}",
	tags: ["administration"],
	security: [{ basicAuth: [] }],
	request: { params: grantParams },
	responses: { 204: { description: "Revoked" }, ...AdminErrorResponses },
});

export const listAdminAuditEvents = createRoute({
	method: "get",
	path: "/v1/admin/audit-events",
	tags: ["administration"],
	security: [{ basicAuth: [] }],
	responses: listResponse(z.object({ items: z.array(AdminAuditEvent) })),
});

export const recoverAdmin = createRoute({
	method: "post",
	path: "/v1/admin/recovery",
	tags: ["administration"],
	security: [{ basicAuth: [] }],
	request: {
		body: { content: { "application/json": { schema: RecoveryInput } } },
	},
	responses: listResponse(AdminActor),
});

type ActorRow = {
	actor_id: string;
	organization_role: "admin" | "user" | "read_only" | null;
	created_at: Date;
};
type GrantRow = {
	actor_id: string;
	project_id: string;
	role: "user" | "read_only";
	created_at: Date;
};
type AuditRow = {
	id: string;
	actor_id: string;
	target_actor_id: string | null;
	organization_id: string;
	project_id: string | null;
	action: string;
	correlation_id: string;
	created_at: Date;
};

function actor(row: ActorRow) {
	return { ...row, created_at: row.created_at.toISOString() };
}

function grant(row: GrantRow) {
	return { ...row, created_at: row.created_at.toISOString() };
}

function audit(row: AuditRow) {
	return { ...row, created_at: row.created_at.toISOString() };
}

function failure(c: Context, cause: unknown): Response {
	const message =
		cause instanceof Error ? cause.message : "Administration failed";
	const code = (cause as { code?: unknown } | null)?.code;
	if (code === "23503" || message === "Not found")
		return c.json(
			{ code: "NOT_FOUND", message: "Resource is not available" },
			404,
		);
	if (message === "Forbidden")
		return c.json({ code: "FORBIDDEN", message }, 403);
	if (message === "Recovery cooldown")
		return c.json({ code: "TOO_MANY_REQUESTS", message }, 429);
	if (
		message.includes("final") ||
		message.includes("already has an active Admin")
	)
		return c.json({ code: "CONFLICT", message }, 409);
	return c.json({ code: "INTERNAL", message: "Administration failed" }, 500);
}

async function requireAdmin(c: Context) {
	try {
		await assertOrganizationAccess(
			pgPool(),
			trustedTenant(c),
			"organization_manage",
		);
	} catch {
		throw new Error("Forbidden");
	}
}

async function lockAdminRoles(
	client: Pick<PoolClient, "query">,
	organizationId: string,
	actorIds: readonly string[],
): Promise<void> {
	await client.query(
		"SELECT membership.actor_subject FROM organization_memberships membership JOIN actor_identities identity ON identity.organization_id = membership.organization_id AND identity.provider_namespace = 'basic:v1' AND identity.canonical_subject = basic_auth_canonical_subject(membership.actor_subject) WHERE membership.organization_id = $1 AND identity.actor_id = ANY($2::uuid[]) ORDER BY membership.actor_subject FOR UPDATE OF membership",
		[organizationId, actorIds],
	);
	await client.query(
		"SELECT actor_id FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = ANY($2::uuid[]) ORDER BY actor_id FOR UPDATE",
		[organizationId, actorIds],
	);
}

async function isAdmin(
	client: Pick<PoolClient, "query">,
	organizationId: string,
	actorId: string,
): Promise<boolean> {
	const result = await client.query<{ allowed: boolean }>(
		"SELECT authorization_allows_organization($1, $2, 'organization_manage') AS allowed",
		[organizationId, actorId],
	);
	return result.rows[0]?.allowed === true;
}

async function lockTargetGrants(
	client: Pick<PoolClient, "query">,
	organizationId: string,
	targetActorId: string,
): Promise<string[]> {
	const legacyGrants = await client.query<{ project_id: string }>(
		"SELECT membership.project_id FROM project_memberships membership JOIN actor_identities identity ON identity.organization_id = membership.organization_id AND identity.actor_id = $2 AND identity.provider_namespace = 'basic:v1' AND membership.actor_subject = identity.canonical_subject WHERE membership.organization_id = $1 ORDER BY membership.project_id FOR UPDATE OF membership",
		[organizationId, targetActorId],
	);
	const grants = await client.query<{ project_id: string }>(
		"SELECT project_id FROM project_actor_grants WHERE organization_id = $1 AND actor_id = $2 ORDER BY project_id FOR UPDATE",
		[organizationId, targetActorId],
	);
	const projectIds = [
		...new Set([
			...grants.rows.map((row) => row.project_id),
			...legacyGrants.rows.map((row) => row.project_id),
		]),
	].sort();
	if (projectIds.length === 0) return projectIds;
	await client.query(
		"SELECT id FROM projects WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE",
		[organizationId, projectIds],
	);
	for (const projectId of projectIds)
		await lockProjectAuditProvenance(client, projectId);
	return projectIds;
}

async function auditEvent(
	client: Pick<PoolClient, "query">,
	input: {
		organizationId: string;
		projectId?: string | null;
		actorId: string;
		targetActorId?: string | null;
		action:
			| "organization_role_set"
			| "project_grant_set"
			| "project_grant_revoked"
			| "recovery_succeeded"
			| "recovery_denied"
			| "recovery_rate_limited";
	},
) {
	await client.query("SELECT audit_admin_access_event($1, $2, $3, $4, $5)", [
		input.organizationId,
		input.projectId ?? null,
		input.actorId,
		input.targetActorId ?? null,
		input.action,
	]);
}

async function actorIsInOrganization(
	client: Pick<PoolClient, "query">,
	organizationId: string,
	actorId: string,
): Promise<boolean> {
	const result = await client.query(
		"SELECT 1 FROM actor_identities WHERE organization_id = $1 AND actor_id = $2 LIMIT 1",
		[organizationId, actorId],
	);
	return Boolean(result.rows[0]);
}

async function lockActiveProject(
	client: Pick<PoolClient, "query">,
	organizationId: string,
	projectId: string,
): Promise<boolean> {
	const project = await client.query(
		"SELECT id FROM projects WHERE id = $1 AND organization_id = $2 AND status = 'active' FOR UPDATE",
		[projectId, organizationId],
	);
	if (!project.rows[0]) return false;
	await lockProjectAuditProvenance(client, projectId);
	return true;
}

export async function handleListAdminActors(c: Context) {
	try {
		await requireAdmin(c);
		const tenant = trustedTenant(c);
		const rows = await pgPool().query<ActorRow>(
			"SELECT identity.actor_id, role.role AS organization_role, COALESCE(role.created_at, MIN(identity.created_at)) AS created_at FROM actor_identities identity LEFT JOIN organization_actor_roles role ON role.organization_id = identity.organization_id AND role.actor_id = identity.actor_id WHERE identity.organization_id = $1 GROUP BY identity.actor_id, role.role, role.created_at ORDER BY COALESCE(role.created_at, MIN(identity.created_at)), identity.actor_id",
			[tenant.organizationId],
		);
		return c.json({ items: rows.rows.map(actor) });
	} catch (cause) {
		return failure(c, cause);
	}
}

export async function handleSetAdminActorRole(c: Context) {
	try {
		await requireAdmin(c);
		const tenant = trustedTenant(c);
		const { actorId } = (c.req as any).valid("param");
		const { role } = (c.req as any).valid("json");
		const result = await withLockPhaseTransaction(
			pgPool(),
			async (client) => {
				await lockAdminRoles(client, tenant.organizationId, [
					tenant.actorId,
					actorId,
				]);
				if (!(await isAdmin(client, tenant.organizationId, tenant.actorId)))
					throw new Error("Forbidden");
				if (
					!(await actorIsInOrganization(client, tenant.organizationId, actorId))
				)
					throw new Error("Not found");
				await lockTargetGrants(client, tenant.organizationId, actorId);
			},
			async (client) => {
				const previous = await client.query<{
					role: "admin" | "user" | "read_only";
				}>(
					"SELECT role FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2",
					[tenant.organizationId, actorId],
				);
				if (role === "admin") {
					const removed = await client.query<{ project_id: string }>(
						"DELETE FROM project_actor_grants WHERE organization_id = $1 AND actor_id = $2 RETURNING project_id",
						[tenant.organizationId, actorId],
					);
					for (const removedGrant of removed.rows)
						await auditEvent(client, {
							organizationId: tenant.organizationId,
							projectId: removedGrant.project_id,
							actorId: tenant.actorId,
							targetActorId: actorId,
							action: "project_grant_revoked",
						});
				}
				const row = await client.query<ActorRow>(
					"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, $3) ON CONFLICT (organization_id, actor_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now() WHERE organization_actor_roles.role IS DISTINCT FROM EXCLUDED.role RETURNING actor_id, role AS organization_role, created_at",
					[tenant.organizationId, actorId, role],
				);
				const current =
					row.rows[0] ??
					(
						await client.query<ActorRow>(
							"SELECT actor_id, role AS organization_role, created_at FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2",
							[tenant.organizationId, actorId],
						)
					).rows[0];
				if (!current) throw new Error("Not found");
				await client.query(
					"INSERT INTO organization_memberships (organization_id, actor_subject, role) SELECT $1, identity.canonical_subject, CASE WHEN $3 = 'admin' THEN 'owner' ELSE 'member' END FROM actor_identities identity WHERE identity.organization_id = $1 AND identity.actor_id = $2 AND identity.provider_namespace = 'basic:v1' ON CONFLICT (organization_id, actor_subject) DO UPDATE SET role = EXCLUDED.role, updated_at = now() WHERE organization_memberships.role IS DISTINCT FROM EXCLUDED.role",
					[tenant.organizationId, actorId, role],
				);
				if (previous.rows[0]?.role !== role)
					await auditEvent(client, {
						organizationId: tenant.organizationId,
						actorId: tenant.actorId,
						targetActorId: actorId,
						action: "organization_role_set",
					});
				return current;
			},
		);
		return c.json(actor(result));
	} catch (cause) {
		return failure(c, cause);
	}
}

export async function handleListProjectGrants(c: Context) {
	try {
		await requireAdmin(c);
		const tenant = trustedTenant(c);
		const { projectId } = (c.req as any).valid("param");
		const project = await pgPool().query(
			"SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2 AND status = 'active'",
			[projectId, tenant.organizationId],
		);
		if (!project.rows[0]) throw new Error("Not found");
		const rows = await pgPool().query<GrantRow>(
			"SELECT actor_id, project_id, role, created_at FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 ORDER BY created_at, actor_id",
			[projectId, tenant.organizationId],
		);
		return c.json({ items: rows.rows.map(grant) });
	} catch (cause) {
		return failure(c, cause);
	}
}

async function mutateProjectGrant(c: Context, revoke = false) {
	await requireAdmin(c);
	const tenant = trustedTenant(c);
	const { projectId, actorId } = (c.req as any).valid("param");
	const role = revoke ? undefined : (c.req as any).valid("json").role;
	const result = await withLockPhaseTransaction(
		pgPool(),
		async (client) => {
			await lockAdminRoles(client, tenant.organizationId, [
				tenant.actorId,
				actorId,
			]);
			if (!(await isAdmin(client, tenant.organizationId, tenant.actorId)))
				throw new Error("Forbidden");
			if (
				!(await actorIsInOrganization(client, tenant.organizationId, actorId))
			)
				throw new Error("Not found");
			await client.query(
				"SELECT membership.actor_subject FROM project_memberships membership JOIN actor_identities identity ON identity.organization_id = membership.organization_id AND identity.actor_id = $3 AND identity.provider_namespace = 'basic:v1' AND membership.actor_subject = identity.canonical_subject WHERE membership.project_id = $1 AND membership.organization_id = $2 FOR UPDATE OF membership",
				[projectId, tenant.organizationId, actorId],
			);
			await client.query(
				"SELECT actor_id FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3 FOR UPDATE",
				[projectId, tenant.organizationId, actorId],
			);
			if (!(await lockActiveProject(client, tenant.organizationId, projectId)))
				throw new Error("Not found");
		},
		async (client) => {
			if (revoke) {
				const deleted = await client.query(
					"DELETE FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3 RETURNING project_id",
					[projectId, tenant.organizationId, actorId],
				);
				if (!deleted.rows[0]) throw new Error("Not found");
				await auditEvent(client, {
					organizationId: tenant.organizationId,
					projectId,
					actorId: tenant.actorId,
					targetActorId: actorId,
					action: "project_grant_revoked",
				});
				return null;
			}
			const existing = await client.query<{ role: "user" | "read_only" }>(
				"SELECT role FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND actor_id = $3",
				[projectId, tenant.organizationId, actorId],
			);
			const target = await client.query<{ role: string }>(
				"SELECT role FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2",
				[tenant.organizationId, actorId],
			);
			if (!target.rows[0] || target.rows[0].role === "admin")
				throw new Error("Not found");
			if (target.rows[0].role === "read_only" && role === "user")
				throw new Error("Project grant exceeds the target organization role");
			const row = await client.query<GrantRow>(
				"INSERT INTO project_actor_grants (project_id, organization_id, actor_id, role) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, actor_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now() RETURNING actor_id, project_id, role, created_at",
				[projectId, tenant.organizationId, actorId, role],
			);
			if (!row.rows[0]) throw new Error("Not found");
			if (existing.rows[0]?.role !== role)
				await client.query(
					"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) SELECT $1, $2, identity.canonical_subject, CASE WHEN $4 = 'user' THEN 'manager' ELSE 'member' END FROM actor_identities identity WHERE identity.organization_id = $2 AND identity.actor_id = $3 AND identity.provider_namespace = 'basic:v1' ON CONFLICT (project_id, actor_subject) DO UPDATE SET role = EXCLUDED.role, updated_at = now() WHERE project_memberships.role IS DISTINCT FROM EXCLUDED.role",
					[projectId, tenant.organizationId, actorId, role],
				);
			if (existing.rows[0]?.role !== role)
				await auditEvent(client, {
					organizationId: tenant.organizationId,
					projectId,
					actorId: tenant.actorId,
					targetActorId: actorId,
					action: "project_grant_set",
				});
			return row.rows[0];
		},
	);
	return result;
}

export async function handleSetProjectGrant(c: Context) {
	try {
		const result = await mutateProjectGrant(c);
		return c.json(grant(result as GrantRow));
	} catch (cause) {
		return failure(c, cause);
	}
}

export async function handleRevokeProjectGrant(c: Context) {
	try {
		await mutateProjectGrant(c, true);
		return c.body(null, 204);
	} catch (cause) {
		return failure(c, cause);
	}
}

export async function handleListAdminAuditEvents(c: Context) {
	try {
		await requireAdmin(c);
		const tenant = trustedTenant(c);
		const rows = await pgPool().query<AuditRow>(
			"SELECT id, actor_id, target_actor_id, organization_id, project_id, action, correlation_id, created_at FROM admin_access_audit_events WHERE organization_id = $1 ORDER BY created_at, id",
			[tenant.organizationId],
		);
		return c.json({ items: rows.rows.map(audit) });
	} catch (cause) {
		return failure(c, cause);
	}
}

function isConfiguredBootstrapOwner(tenant: ReturnType<typeof trustedTenant>) {
	const username = process.env.ASTRAEA_BOOTSTRAP_OWNER_USERNAME;
	if (!username) return false;
	const matches = basicCredentialsFromEnvironment().filter(
		(credential) => credential.username === username,
	);
	return (
		matches.length === 1 &&
		matches[0]?.organizationId === tenant.organizationId &&
		matches[0]?.actorId === tenant.actorId
	);
}

export async function handleRecoverAdmin(c: Context) {
	try {
		const tenant = trustedTenant(c);
		if (!isConfiguredBootstrapOwner(tenant)) throw new Error("Forbidden");
		const recovered = await withLockPhaseTransaction<
			ActorRow | "cooldown" | "active_admin"
		>(
			pgPool(),
			async (client) => {
				await lockAdminRoles(client, tenant.organizationId, [tenant.actorId]);
				await client.query(
					"SELECT organization_id FROM admin_recovery_controls WHERE organization_id = $1 FOR UPDATE",
					[tenant.organizationId],
				);
				await lockTargetGrants(client, tenant.organizationId, tenant.actorId);
				await client.query(
					"SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE",
					[tenant.organizationId],
				);
			},
			async (client) => {
				const control = await client.query<{
					cooldown_expires_at: Date | null;
				}>(
					"SELECT cooldown_expires_at FROM admin_recovery_controls WHERE organization_id = $1",
					[tenant.organizationId],
				);
				if (
					control.rows[0]?.cooldown_expires_at &&
					control.rows[0].cooldown_expires_at > new Date()
				) {
					await auditEvent(client, {
						organizationId: tenant.organizationId,
						actorId: tenant.actorId,
						targetActorId: tenant.actorId,
						action: "recovery_rate_limited",
					});
					return "cooldown";
				}
				const activeAdmin = await client.query(
					"SELECT 1 FROM organization_actor_roles role WHERE role.organization_id = $1 AND organization_actor_is_usable_admin(role.organization_id, role.actor_id) LIMIT 1",
					[tenant.organizationId],
				);
				if (activeAdmin.rows[0]) {
					await client.query(
						"INSERT INTO admin_recovery_controls (organization_id, last_attempted_at, cooldown_expires_at, updated_at) VALUES ($1, now(), now() + interval '15 minutes', now()) ON CONFLICT (organization_id) DO UPDATE SET last_attempted_at = EXCLUDED.last_attempted_at, cooldown_expires_at = EXCLUDED.cooldown_expires_at, updated_at = EXCLUDED.updated_at",
						[tenant.organizationId],
					);
					await auditEvent(client, {
						organizationId: tenant.organizationId,
						actorId: tenant.actorId,
						targetActorId: tenant.actorId,
						action: "recovery_denied",
					});
					return "active_admin";
				}
				const removed = await client.query<{ project_id: string }>(
					"DELETE FROM project_actor_grants WHERE organization_id = $1 AND actor_id = $2 RETURNING project_id",
					[tenant.organizationId, tenant.actorId],
				);
				for (const removedGrant of removed.rows)
					await auditEvent(client, {
						organizationId: tenant.organizationId,
						projectId: removedGrant.project_id,
						actorId: tenant.actorId,
						targetActorId: tenant.actorId,
						action: "project_grant_revoked",
					});
				const row = await client.query<ActorRow>(
					"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, 'admin') ON CONFLICT (organization_id, actor_id) DO UPDATE SET role = 'admin', updated_at = now() RETURNING actor_id, role AS organization_role, created_at",
					[tenant.organizationId, tenant.actorId],
				);
				const value = row.rows[0];
				if (!value) throw new Error("Not found");
				await client.query(
					"INSERT INTO admin_recovery_controls (organization_id, last_attempted_at, last_recovered_at, cooldown_expires_at, updated_at) VALUES ($1, now(), now(), now() + interval '15 minutes', now()) ON CONFLICT (organization_id) DO UPDATE SET last_attempted_at = EXCLUDED.last_attempted_at, last_recovered_at = EXCLUDED.last_recovered_at, cooldown_expires_at = EXCLUDED.cooldown_expires_at, updated_at = EXCLUDED.updated_at",
					[tenant.organizationId],
				);
				await auditEvent(client, {
					organizationId: tenant.organizationId,
					actorId: tenant.actorId,
					targetActorId: tenant.actorId,
					action: "recovery_succeeded",
				});
				return value;
			},
		);
		if (recovered === "cooldown")
			return c.json(
				{ code: "TOO_MANY_REQUESTS", message: "Recovery cooldown" },
				429,
			);
		if (recovered === "active_admin")
			return c.json(
				{
					code: "CONFLICT",
					message: "Organization already has an active Admin",
				},
				409,
			);
		return c.json(actor(recovered));
	} catch (cause) {
		return failure(c, cause);
	}
}
