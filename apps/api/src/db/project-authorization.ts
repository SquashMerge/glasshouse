import type { Pool, PoolClient } from "pg";
import type { ProjectOperation } from "../authorization-policy.js";
import type { TrustedTenantContext } from "../middleware/auth.js";

export type ProjectAuthorization = {
	organization_id: string;
	actor_id: string;
	operation: ProjectOperation;
};

export type AuthorizedProjectStatus = "active" | "archived" | "deleting";

type Transactional = Pick<Pool, "connect">;

const LOCK_PHASE_ATTEMPTS = 2;

type ProjectLockOptions = {
	memberSubject?: string;
	lockAllProjectMembers?: boolean;
};

export function projectAuthorization(
	tenant: TrustedTenantContext,
	operation: ProjectOperation,
): ProjectAuthorization {
	return {
		organization_id: tenant.organizationId,
		actor_id: tenant.actorId,
		operation,
	};
}

export async function lockFirstAdminCreation(
	client: Pick<PoolClient, "query">,
	organizationId: string,
): Promise<void> {
	// Bootstrap and recovery take this before row locks. Keep it separate from
	// seed 51, which final-Admin triggers acquire after role/Project row locks.
	await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 98))", [
		organizationId,
	]);
}

export async function lockProjectAuditProvenance(
	client: Pick<PoolClient, "query">,
	projectId: string,
): Promise<void> {
	await client.query("SELECT lock_project_audit_provenance($1::uuid)", [
		projectId,
	]);
}

export async function withLockPhaseTransaction<T>(
	db: Transactional,
	lock: (client: PoolClient) => Promise<void>,
	mutate: (client: PoolClient) => Promise<T>,
): Promise<T> {
	for (let attempt = 0; attempt < LOCK_PHASE_ATTEMPTS; attempt += 1) {
		const client = await db.connect();
		let transactionOpen = false;
		let mutationStarted = false;
		try {
			await client.query("BEGIN");
			transactionOpen = true;
			await lock(client);
			mutationStarted = true;
			const value = await mutate(client);
			await client.query("COMMIT");
			transactionOpen = false;
			return value;
		} catch (cause) {
			if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
			if (
				!mutationStarted &&
				attempt + 1 < LOCK_PHASE_ATTEMPTS &&
				isRetryableLockError(cause)
			)
				continue;
			throw cause;
		} finally {
			client.release();
		}
	}
	throw new Error("Authorization lock retry attempts were exhausted");
}

function isRetryableLockError(cause: unknown): boolean {
	const code = (cause as { code?: unknown } | null)?.code;
	return code === "40P01" || code === "40001";
}

export async function lockActiveAuthorizedProject(
	client: Pick<PoolClient, "query">,
	projectId: string,
	authorization: ProjectAuthorization,
): Promise<boolean> {
	return lockAuthorizedProject(client, projectId, authorization, ["active"]);
}

export async function lockAuthorizedProject(
	client: Pick<PoolClient, "query">,
	projectId: string,
	authorization: ProjectAuthorization,
	statuses: readonly AuthorizedProjectStatus[],
	options: ProjectLockOptions = {},
): Promise<boolean> {
	await client.query(
		"SELECT om.actor_subject FROM organization_memberships om WHERE om.organization_id = $1 AND basic_auth_identity_matches($1, om.actor_subject, $2) FOR UPDATE",
		[authorization.organization_id, authorization.actor_id],
	);
	await client.query(
		"SELECT actor_id FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2 FOR UPDATE",
		[authorization.organization_id, authorization.actor_id],
	);
	await client.query(
		"SELECT pm.actor_subject FROM project_memberships pm WHERE pm.project_id = $1 AND pm.organization_id = $2 AND ($5::boolean OR basic_auth_identity_matches($2, pm.actor_subject, $3) OR pm.actor_subject = $4) ORDER BY pm.actor_subject FOR UPDATE",
		[
			projectId,
			authorization.organization_id,
			authorization.actor_id,
			options.memberSubject ?? null,
			options.lockAllProjectMembers ?? false,
		],
	);
	await client.query(
		"SELECT actor_id FROM project_actor_grants WHERE project_id = $1 AND organization_id = $2 AND ($4::boolean OR actor_id = $3) ORDER BY actor_id FOR UPDATE",
		[
			projectId,
			authorization.organization_id,
			authorization.actor_id,
			options.lockAllProjectMembers ?? false,
		],
	);
	const project = await client.query(
		"SELECT p.id FROM projects p WHERE p.id = $1 AND p.organization_id = $2 AND p.status = ANY($3::text[]) FOR UPDATE OF p",
		[projectId, authorization.organization_id, statuses],
	);
	if (!project.rows[0]) return false;
	const decision = await client.query<{ allowed: boolean }>(
		"SELECT authorization_allows_project($1, $2, $3, $4) AS allowed",
		[
			authorization.organization_id,
			projectId,
			authorization.actor_id,
			authorization.operation,
		],
	);
	return decision.rows[0]?.allowed === true;
}

export async function lockAuthorizedOrganization(
	client: Pick<PoolClient, "query">,
	organizationId: string,
	actorId: string,
	operation: "organization_manage" | "destructive" | "governed",
	memberSubject?: string,
): Promise<boolean> {
	await client.query(
		memberSubject
			? "SELECT actor_subject FROM organization_memberships WHERE organization_id = $1 AND (basic_auth_identity_matches($1, actor_subject, $2) OR actor_subject = $3) ORDER BY actor_subject FOR UPDATE"
			: "SELECT actor_subject FROM organization_memberships WHERE organization_id = $1 AND basic_auth_identity_matches($1, actor_subject, $2) FOR UPDATE",
		memberSubject
			? [organizationId, actorId, memberSubject]
			: [organizationId, actorId],
	);
	await client.query(
		"SELECT actor_id FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2 FOR UPDATE",
		[organizationId, actorId],
	);
	const decision = await client.query<{ allowed: boolean }>(
		"SELECT authorization_allows_organization($1, $2, $3) AS allowed",
		[organizationId, actorId, operation],
	);
	return decision.rows[0]?.allowed === true;
}

export async function lockActiveAuthorizedOrganizationProject(
	client: Pick<PoolClient, "query">,
	projectId: string,
	organizationId: string,
	actorId: string,
	operation: "organization_manage" | "destructive" | "governed",
): Promise<boolean> {
	if (
		!(await lockAuthorizedOrganization(
			client,
			organizationId,
			actorId,
			operation,
		))
	)
		return false;
	const project = await client.query(
		"SELECT id FROM projects WHERE id = $1 AND organization_id = $2 AND status = 'active' FOR UPDATE",
		[projectId, organizationId],
	);
	return Boolean(project.rows[0]);
}
