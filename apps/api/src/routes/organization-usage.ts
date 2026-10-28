import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Pool, QueryResultRow } from "pg";
import { defaultClient } from "../db/traces-query.js";
import { pgPool } from "../db/postgres.js";
import {
	getOrganizationUsage,
	type OrganizationUsageDashboard as Dashboard,
	type OrganizationUsageRange,
	type UsageProject,
} from "../db/organization-usage.js";
import {
	OrganizationUsageDashboard,
	OrganizationUsageQuery,
} from "../schemas/organization-usage.js";
import { ErrorEnvelope } from "../schemas/common.js";
import { trustedTenant, TenantScopeError } from "../tenancy.js";
import { logger } from "../lib/logger.js";

export const getOrganizationUsageRoute = createRoute({
	method: "get",
	path: "/v1/organization/usage",
	tags: ["organization"],
	summary: "Get organization-wide persisted telemetry usage",
	description:
		"Returns row counts for retained traces and observations across active and archived Projects in the authenticated Organization. Counts use start_time in the selected UTC interval and include aggregate metadata only.",
	security: [{ basicAuth: [] }],
	request: { query: OrganizationUsageQuery },
	responses: {
		200: {
			description: "Organization usage dashboard",
			content: { "application/json": { schema: OrganizationUsageDashboard } },
		},
		400: {
			description: "Invalid query parameters",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		401: {
			description: "Authentication required",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		404: {
			description: "Organization is not available",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		500: {
			description: "Internal error",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
	},
});

type ProjectRow = QueryResultRow & {
	id: string;
	name: string;
	slug: string;
	status: "active" | "archived";
};

export async function listEligibleOrganizationUsageProjects(
	pool: Pick<Pool, "query">,
	organizationId: string,
): Promise<UsageProject[]> {
	const result = await pool.query<ProjectRow>(
		"SELECT id, name, slug, status FROM projects WHERE organization_id = $1 AND status IN ('active', 'archived') ORDER BY slug, id",
		[organizationId],
	);
	return result.rows;
}

export type OrganizationUsageDependencies = {
	isOrganizationMember: (
		organizationId: string,
		actorId: string,
	) => Promise<boolean>;
	listProjects: (organizationId: string) => Promise<UsageProject[]>;
	getUsage: (
		organizationId: string,
		projects: UsageProject[],
		range: OrganizationUsageRange,
	) => Promise<Dashboard>;
};

const defaultDependencies: OrganizationUsageDependencies = {
	async isOrganizationMember(organizationId, actorId) {
		const result = await pgPool().query(
			"SELECT 1 FROM organization_actor_roles role WHERE role.organization_id = $1 AND role.actor_id = $2 AND EXISTS (SELECT 1 FROM actor_identities identity WHERE identity.organization_id = role.organization_id AND identity.actor_id = role.actor_id AND identity.provider_namespace IN ('basic:v1', 'local:v1')) AND local_actor_authentication_enabled($1, $2)",
			[organizationId, actorId],
		);
		return Boolean(result.rows[0]);
	},
	async listProjects(organizationId) {
		return listEligibleOrganizationUsageProjects(pgPool(), organizationId);
	},
	async getUsage(organizationId, projects, range) {
		return getOrganizationUsage(defaultClient(), {
			organization_id: organizationId,
			projects,
			range,
		});
	},
};

export function createOrganizationUsageHandler(
	dependencies: OrganizationUsageDependencies = defaultDependencies,
) {
	return async function handleOrganizationUsage(c: Context): Promise<Response> {
		try {
			const tenant = trustedTenant(c);
			const query = (
				c.req as {
					valid: (target: "query") => { range: OrganizationUsageRange };
				}
			).valid("query");
			if (
				!(await dependencies.isOrganizationMember(
					tenant.organizationId,
					tenant.actorId,
				))
			)
				return c.json(
					{ code: "NOT_FOUND", message: "Organization is not available" },
					404,
				);
			const projects = await dependencies.listProjects(tenant.organizationId);
			return c.json(
				await dependencies.getUsage(
					tenant.organizationId,
					projects,
					query.range,
				),
			);
		} catch (cause) {
			if (cause instanceof TenantScopeError)
				return c.json(
					{ code: "UNAUTHORIZED", message: "Authentication required" },
					401,
				);
			logger.error("organization_usage.request_failed", cause);
			return c.json(
				{ code: "INTERNAL", message: "Could not load organization usage" },
				500,
			);
		}
	};
}

export const handleOrganizationUsage = createOrganizationUsageHandler();
