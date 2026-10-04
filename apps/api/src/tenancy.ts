import type { Context } from "hono";
import type { Pool } from "pg";
import {
	TRUSTED_TENANT_CONTEXT_KEY,
	type TrustedTenantContext,
} from "./middleware/auth.js";
import type {
	AuthorizationEnforcement,
	EffectiveProjectRole,
	ProjectOperation,
} from "./authorization-policy.js";
import { lockActiveAuthorizedProject } from "./db/project-authorization.js";
import { lockSessionPrincipal } from "./db/local-sessions.js";

export type AuthorizedProjectScope = TrustedTenantContext & {
	projectId: string;
	projectRole: EffectiveProjectRole;
	enforcement: AuthorizationEnforcement;
	projectStatus: "active" | "archived" | "deleting";
};
export type TenantScope = AuthorizedProjectScope;
type Transactional = Pick<Pool, "connect">;
const AUTHORIZATION_LOCK_ATTEMPTS = 2;

export type ActiveAuthorizedProjectScope = Pick<
	TrustedTenantContext,
	"actorId" | "organizationId" | "sessionId"
> & {
	projectId: string;
};

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
	operation: ProjectOperation = "product_read",
): Promise<AuthorizedProjectScope> {
	const result = await pool.query<{
		effective_role: EffectiveProjectRole | null;
		enforcement: AuthorizationEnforcement;
		project_status: "active" | "archived" | "deleting";
		allowed: boolean;
	}>(
		"SELECT decision.effective_role, decision.enforcement, decision.project_status, authorization_allows_project($1, $2, $3, $4) AS allowed FROM authorization_effective_project_role($1, $2, $3) AS decision",
		[tenant.organizationId, projectId, tenant.actorId, operation],
	);
	const row = result.rows[0];
	if (!row?.effective_role || !row.allowed)
		throw new TenantScopeError("Project is not available");
	return {
		...tenant,
		projectId,
		projectRole: row.effective_role,
		enforcement: row.enforcement,
		projectStatus: row.project_status,
	};
}

export async function assertTenantProjectAccess(
	pool: Pick<Pool, "query">,
	tenant: TrustedTenantContext,
	projectId: string,
	operation: ProjectOperation = "product_read",
): Promise<void> {
	await resolveAuthorizedProjectScope(pool, tenant, projectId, operation);
}

export async function resolveTenantProject(
	pool: Pick<Pool, "query">,
	tenant: TrustedTenantContext,
	requestedProjectId?: string,
	operation: ProjectOperation = "product_read",
): Promise<TenantScope> {
	if (!requestedProjectId)
		throw new TenantScopeError("Project target is required");
	const scope = await resolveAuthorizedProjectScope(
		pool,
		tenant,
		requestedProjectId,
		operation,
	);
	return scope;
}

export async function assertOrganizationAccess(
	pool: Pick<Pool, "query">,
	tenant: TrustedTenantContext,
	operation: "organization_manage" | "destructive" | "governed",
): Promise<void> {
	const result = await pool.query<{ allowed: boolean }>(
		"SELECT authorization_allows_organization($1, $2, $3) AS allowed",
		[tenant.organizationId, tenant.actorId, operation],
	);
	if (!result.rows[0]?.allowed)
		throw new TenantScopeError("Organization is not available");
}

export async function withActiveAuthorizedProjectLock<T>(
	db: Transactional,
	tenant: ActiveAuthorizedProjectScope,
	callback: () => Promise<T>,
	operation: ProjectOperation = "product_write",
	lockTimeoutMs?: number,
): Promise<T> {
	for (let attempt = 0; attempt < AUTHORIZATION_LOCK_ATTEMPTS; attempt += 1) {
		const client = await db.connect();
		let transactionOpen = false;
		let callbackStarted = false;
		try {
			await client.query("BEGIN");
			transactionOpen = true;
			if (lockTimeoutMs !== undefined)
				await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
			if (tenant.sessionId)
				await lockSessionPrincipal(client, {
					...tenant,
					sessionId: tenant.sessionId,
				});
			if (
				!(await lockActiveAuthorizedProject(client, tenant.projectId, {
					organization_id: tenant.organizationId,
					actor_id: tenant.actorId,
					operation,
				}))
			)
				throw new TenantScopeError("Project is not available");
			callbackStarted = true;
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
			if (
				!callbackStarted &&
				attempt + 1 < AUTHORIZATION_LOCK_ATTEMPTS &&
				isRetryableAuthorizationLockError(cause)
			)
				continue;
			throw cause;
		} finally {
			client.release();
		}
	}
	throw new Error("Authorization lock retry attempts were exhausted");
}

function isRetryableAuthorizationLockError(cause: unknown): boolean {
	const code = (cause as { code?: unknown } | null)?.code;
	return code === "40P01" || code === "40001";
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
