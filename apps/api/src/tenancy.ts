import type { Context } from "hono";
import type { Pool } from "pg";
import {
	TRUSTED_TENANT_CONTEXT_KEY,
	type TrustedTenantContext,
} from "./middleware/auth.js";

export type TenantScope = TrustedTenantContext & {
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

export async function assertTenantProjectAccess(
	pool: Pick<Pool, "query">,
	tenant: TrustedTenantContext,
	projectId: string,
): Promise<void> {
	const result = await pool.query<{ id: string }>(
		"SELECT id FROM projects WHERE id = $1 AND organization_id = $2",
		[projectId, tenant.organizationId],
	);
	if (!result.rows[0]?.id)
		throw new TenantScopeError("Project is not available to this organization");
}

export async function resolveTenantProject(
	pool: Pick<Pool, "query">,
	tenant: TrustedTenantContext,
	requestedProjectId?: string,
): Promise<TenantScope> {
	const result = requestedProjectId
		? await pool.query<{ id: string }>(
				"SELECT id FROM projects WHERE id = $1 AND organization_id = $2",
				[requestedProjectId, tenant.organizationId],
			)
		: await pool.query<{ id: string }>(
				"SELECT id FROM projects WHERE organization_id = $1 AND slug = 'default' LIMIT 1",
				[tenant.organizationId],
			);
	const projectId = result.rows[0]?.id;
	if (!projectId) {
		throw new TenantScopeError("Project is not available to this organization");
	}
	return { ...tenant, projectId };
}
