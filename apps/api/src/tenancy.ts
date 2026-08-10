import type { Context } from "hono";
import type { Pool, PoolClient } from "pg";
import {
	TRUSTED_TENANT_CONTEXT_KEY,
	type TrustedTenantContext,
} from "./middleware/auth.js";

export type AuthorizedProjectScope = TrustedTenantContext & {
	projectId: string;
	organizationRole: "owner" | "member";
	projectRole: "manager" | "member";
	projectStatus: "active" | "archived" | "deleting";
};
export type TenantScope = AuthorizedProjectScope;
type Transactional = Pick<Pool, "connect">;

export class TenantScopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TenantScopeError";
	}
}

export function trustedTenant(c: Context): TrustedTenantContext {
	const tenant = c.get(TRUSTED_TENANT_CONTEXT_KEY) as
		| TrustedTenantContext
		| undefined;
	if (!tenant?.actor || !tenant.organizationId) {
		throw new TenantScopeError("Authenticated tenant context is missing");
	}
	return tenant;
}

export async function resolveAuthorizedProjectScope(
	pool: Pick<Pool, "query">,
	tenant: TrustedTenantContext,
	projectId: string,
): Promise<AuthorizedProjectScope> {
	const result = await pool.query<{
		organization_role: "owner" | "member";
		project_role: "manager" | "member";
		status: "active" | "archived" | "deleting";
	}>(
		"SELECT om.role AS organization_role, CASE WHEN om.role = 'owner' THEN 'manager' ELSE pm.role END AS project_role, p.status FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id JOIN actor_identities identity ON identity.actor_id = $3 AND identity.organization_id = p.organization_id AND identity.provider_namespace = 'basic:v1' AND identity.canonical_subject = basic_auth_canonical_subject(om.actor_subject) LEFT JOIN project_memberships pm ON pm.project_id = p.id AND basic_auth_canonical_subject(pm.actor_subject) = identity.canonical_subject WHERE p.id = $1 AND p.organization_id = $2 AND (om.role = 'owner' OR pm.actor_subject IS NOT NULL)",
		[projectId, tenant.organizationId, tenant.actorId],
	);
	const row = result.rows[0];
	if (!row) throw new TenantScopeError("Project is not available");
	return {
		...tenant,
		projectId,
		organizationRole: row.organization_role,
		projectRole: row.project_role,
		projectStatus: row.status,
	};
}

export async function assertTenantProjectAccess(
	pool: Pick<Pool, "query">,
	tenant: TrustedTenantContext,
	projectId: string,
): Promise<void> {
	const scope = await resolveAuthorizedProjectScope(pool, tenant, projectId);
	if (scope.projectStatus !== "active")
		throw new TenantScopeError("Project is not available");
}

export async function resolveTenantProject(
	pool: Pick<Pool, "query">,
	tenant: TrustedTenantContext,
	requestedProjectId?: string,
): Promise<TenantScope> {
	if (!requestedProjectId)
		throw new TenantScopeError("Project target is required");
	const scope = await resolveAuthorizedProjectScope(
		pool,
		tenant,
		requestedProjectId,
	);
	if (scope.projectStatus !== "active")
		throw new TenantScopeError("Project is not available");
	return scope;
}

export async function withActiveAuthorizedProjectLock<T>(
	db: Transactional,
	tenant: TenantScope,
	callback: () => Promise<T>,
): Promise<T> {
	const client = await db.connect();
	let transactionOpen = false;
	try {
		await client.query("BEGIN");
		transactionOpen = true;
		const authorized = await lockedActiveProjectAccess(client, tenant);
		if (!authorized.rows[0])
			throw new TenantScopeError("Project is not available");
		const value = await callback();
		await client.query("COMMIT");
		transactionOpen = false;
		return value;
	} catch (cause) {
		if (transactionOpen) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// Preserve the authorization or persistence failure that triggered rollback.
			}
		}
		throw cause;
	} finally {
		client.release();
	}
}

function lockedActiveProjectAccess(client: PoolClient, tenant: TenantScope) {
	return client.query(
		"SELECT p.id FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id JOIN actor_identities identity ON identity.actor_id = $3 AND identity.organization_id = p.organization_id AND identity.provider_namespace = 'basic:v1' AND identity.canonical_subject = basic_auth_canonical_subject(om.actor_subject) LEFT JOIN LATERAL (SELECT role FROM project_memberships WHERE project_id = p.id AND basic_auth_canonical_subject(actor_subject) = identity.canonical_subject FOR UPDATE) pm ON true WHERE p.id = $1 AND p.organization_id = $2 AND p.status = 'active' AND (om.role = 'owner' OR pm.role IS NOT NULL) FOR UPDATE OF p, om",
		[tenant.projectId, tenant.organizationId, tenant.actorId],
	);
}

export type InternalEvaluationProjectScope = Pick<
	TenantScope,
	"actorId" | "organizationId" | "projectId"
>;

export async function withActiveInternalEvaluationProjectLock<T>(
	db: Transactional,
	tenant: InternalEvaluationProjectScope,
	callback: () => Promise<T>,
): Promise<T> {
	const client = await db.connect();
	let transactionOpen = false;
	try {
		await client.query("BEGIN");
		transactionOpen = true;
		const authorized = await client.query(
			"SELECT p.id FROM projects p JOIN actor_identities worker ON worker.actor_id = $3 AND worker.organization_id = p.organization_id AND worker.provider_namespace = 'internal:evaluation-worker:v1' AND worker.canonical_subject = p.organization_id::text WHERE p.id = $1 AND p.organization_id = $2 AND p.status = 'active' FOR UPDATE OF p",
			[tenant.projectId, tenant.organizationId, tenant.actorId],
		);
		if (!authorized.rows[0])
			throw new TenantScopeError("Project is not available");
		const value = await callback();
		await client.query("COMMIT");
		transactionOpen = false;
		return value;
	} catch (cause) {
		if (transactionOpen) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// Preserve the authorization or persistence failure that triggered rollback.
			}
		}
		throw cause;
	} finally {
		client.release();
	}
}
