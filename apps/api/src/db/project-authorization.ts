import type { PoolClient } from "pg";
import type { ProjectOperation } from "../authorization-policy.js";
import type { TrustedTenantContext } from "../middleware/auth.js";

export type ProjectAuthorization = {
	organization_id: string;
	actor_id: string;
	operation: ProjectOperation;
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

export async function lockActiveAuthorizedProject(
	client: Pick<PoolClient, "query">,
	projectId: string,
	authorization: ProjectAuthorization,
): Promise<boolean> {
	const result = await client.query(
		"SELECT p.id FROM projects p WHERE p.id = $1 AND p.organization_id = $2 AND p.status = 'active' AND authorization_allows_project($2, $1, $3, $4) FOR UPDATE OF p",
		[
			projectId,
			authorization.organization_id,
			authorization.actor_id,
			authorization.operation,
		],
	);
	return Boolean(result.rows[0]);
}
