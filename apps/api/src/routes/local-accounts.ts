import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
	LocalCredentialError,
	LocalCredentialStore,
} from "../db/local-credentials.js";
import { AuthenticationError } from "../db/local-sessions.js";
import { pgPool } from "../db/postgres.js";
import { AdminErrorResponses, AdminRole } from "../schemas/admin-access.js";
import { assertOrganizationAccess, trustedTenant } from "../tenancy.js";

const Id = z.string().uuid();
const Timestamp = z.string().datetime();
const LocalEnrollment = z
	.object({
		id: Id,
		status: z.enum(["pending", "expired", "revoked", "consumed"]),
		created_at: Timestamp,
		expires_at: Timestamp,
	})
	.strict()
	.openapi("LocalEnrollment");
const LocalAccount = z
	.object({
		actor_id: Id,
		username: z.string(),
		organization_role: AdminRole.nullable(),
		status: z.enum(["active", "pending", "disabled"]),
		enrollments: z.array(LocalEnrollment),
	})
	.strict()
	.openapi("LocalAccount");
const Username = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/);
const EnrollmentCode = z
	.object({
		actor_id: Id,
		username: Username,
		enrollment_id: Id,
		code: z.string().length(43).openapi({
			description:
				"One-time enrollment code; shown only in this response. Never store, log, or include in a URL.",
		}),
	})
	.strict()
	.openapi("EnrollmentCode");
const body = (schema: z.ZodType) => ({
	required: true,
	content: { "application/json": { schema } },
});
const response = (schema: z.ZodType) => ({
	200: {
		description: "OK; sensitive responses are not cached",
		content: { "application/json": { schema } },
	},
	...AdminErrorResponses,
});
const common = { tags: ["administration"], security: [{ basicAuth: [] }] };
const actorParams = z.object({ actorId: Id });

export const listLocalAccountsRoute = createRoute({
	...common,
	method: "get",
	path: "/v1/admin/local-accounts",
	summary: "List local usernames, current roles and enrollment status",
	responses: response(z.object({ items: z.array(LocalAccount) })),
});
export const provisionLocalAccountRoute = createRoute({
	...common,
	method: "post",
	path: "/v1/admin/local-accounts",
	summary: "Provision a local username and reveal its enrollment code once",
	request: {
		body: body(z.object({ username: Username, role: AdminRole }).strict()),
	},
	responses: response(EnrollmentCode),
});
export const setLocalAccountStatusRoute = createRoute({
	...common,
	method: "put",
	path: "/v1/admin/local-accounts/{actorId}/status",
	summary: "Enable or disable a local account without removing its roles",
	request: {
		params: actorParams,
		body: body(z.object({ enabled: z.boolean() }).strict()),
	},
	responses: response(z.object({ ok: z.literal(true) })),
});
export const resetLocalAccountRoute = createRoute({
	...common,
	method: "post",
	path: "/v1/admin/local-accounts/{actorId}/reset",
	summary:
		"Revoke passwords, sessions and enrollments and reveal a replacement code once",
	request: { params: actorParams },
	responses: response(EnrollmentCode),
});
export const revokeLocalEnrollmentRoute = createRoute({
	...common,
	method: "delete",
	path: "/v1/admin/local-enrollments/{enrollmentId}",
	summary: "Revoke an unused local enrollment code",
	request: { params: z.object({ enrollmentId: Id }) },
	responses: response(z.object({ ok: z.literal(true) })),
});

async function manage(
	c: Context,
	run: (
		store: LocalCredentialStore,
		tenant: ReturnType<typeof trustedTenant>,
	) => Promise<Record<string, unknown>>,
) {
	c.header("Cache-Control", "no-store");
	const tenant = trustedTenant(c);
	try {
		await assertOrganizationAccess(pgPool(), tenant, "organization_manage");
	} catch {
		return c.json(
			{ code: "FORBIDDEN", message: "Administration requires an Admin" },
			403,
		);
	}
	try {
		return c.json(
			await run(
				new LocalCredentialStore(pgPool(), tenant.organizationId),
				tenant,
			),
		);
	} catch (cause) {
		if (cause instanceof AuthenticationError) throw cause;
		if (cause instanceof LocalCredentialError)
			return c.json(
				{
					code: "CONFLICT",
					message:
						"Account change unavailable. Review account state and keep another enrolled, enabled Admin.",
				},
				409,
			);
		throw cause;
	}
}

export async function handleListLocalAccounts(c: Context) {
	return manage(c, async (_store, tenant) => {
		const accounts = await pgPool().query(
			`SELECT credential.actor_id, credential.username, role.role AS organization_role,
			CASE WHEN NOT credential.enabled THEN 'disabled' WHEN credential.password_hash IS NULL THEN 'pending' ELSE 'active' END AS status,
			COALESCE((SELECT jsonb_agg(jsonb_build_object('id', enrollment.id, 'status',
			CASE WHEN enrollment.revoked_at IS NOT NULL THEN 'revoked' WHEN enrollment.consumed_at IS NOT NULL THEN 'consumed'
			WHEN enrollment.expires_at <= clock_timestamp() THEN 'expired' ELSE 'pending' END,
			'created_at', enrollment.created_at, 'expires_at', enrollment.expires_at) ORDER BY enrollment.created_at DESC, enrollment.id)
			FROM local_account_enrollments enrollment WHERE enrollment.organization_id = credential.organization_id AND enrollment.actor_id = credential.actor_id), '[]'::jsonb) AS enrollments
			FROM local_credentials credential LEFT JOIN organization_actor_roles role
			ON role.organization_id = credential.organization_id AND role.actor_id = credential.actor_id
			WHERE credential.organization_id = $1 ORDER BY credential.username`,
			[tenant.organizationId],
		);
		return { items: accounts.rows };
	});
}

export async function handleProvisionLocalAccount(c: Context) {
	return manage(c, async (store, tenant) => {
		const result = await store.provision(tenant, (c.req as any).valid("json"));
		return {
			actor_id: result.actorId,
			username: result.username,
			enrollment_id: result.enrollmentId,
			code: result.token,
		};
	});
}

export async function handleSetLocalAccountStatus(c: Context) {
	return manage(c, async (store, tenant) => {
		await store.setEnabled(
			tenant,
			(c.req as any).valid("param").actorId,
			(c.req as any).valid("json").enabled,
		);
		return { ok: true };
	});
}

export async function handleResetLocalAccount(c: Context) {
	return manage(c, async (store, tenant) => {
		const { actorId } = (c.req as any).valid("param");
		const result = await store.initiatePasswordReset(tenant, actorId);
		return {
			actor_id: actorId,
			username: result.username,
			enrollment_id: result.enrollmentId,
			code: result.token,
		};
	});
}

export async function handleRevokeLocalEnrollment(c: Context) {
	return manage(c, async (store, tenant) => {
		await store.revokeEnrollment(
			tenant,
			(c.req as any).valid("param").enrollmentId,
		);
		return { ok: true };
	});
}

export const localAccountRoutes = [
	[listLocalAccountsRoute, handleListLocalAccounts],
	[provisionLocalAccountRoute, handleProvisionLocalAccount],
	[setLocalAccountStatusRoute, handleSetLocalAccountStatus],
	[resetLocalAccountRoute, handleResetLocalAccount],
	[revokeLocalEnrollmentRoute, handleRevokeLocalEnrollment],
] as const;
