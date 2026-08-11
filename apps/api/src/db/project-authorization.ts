import type { PoolClient } from "pg";
import type { ProjectOperation } from "../authorization-policy.js";
import type { TrustedTenantContext } from "../middleware/auth.js";

export type ProjectAuthorization = {
	organization_id: string;
	actor_id: string;
	operation: ProjectOperation;
};

export type AuthorizedProjectStatus = "active" | "archived" | "deleting";

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
): Promise<boolean> {
	const project = await client.query(
		"SELECT p.id FROM projects p WHERE p.id = $1 AND p.organization_id = $2 AND p.status = ANY($5::text[]) FOR UPDATE OF p",
		[
			projectId,
			authorization.organization_id,
			authorization.actor_id,
			authorization.operation,
			statuses,
		],
	);
	if (!project.rows[0]) return false;

	await client.query(
		"SELECT om.actor_subject FROM organization_memberships om WHERE om.organization_id = $1 AND basic_auth_identity_matches($1, om.actor_subject, $2) FOR UPDATE",
		[authorization.organization_id, authorization.actor_id],
	);
	await client.query(
		"SELECT pm.actor_subject FROM project_memberships pm WHERE pm.project_id = $1 AND pm.organization_id = $2 AND basic_auth_identity_matches($2, pm.actor_subject, $3) FOR UPDATE",
		[projectId, authorization.organization_id, authorization.actor_id],
	);
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
