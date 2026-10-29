import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { PoolClient } from "pg";
import {
	createOtlpCredential as createCredentialRecord,
	listOtlpCredentials as listCredentialRecords,
	OtlpCredentialNotFoundError,
	revokeOtlpCredential as revokeCredentialRecord,
	rotateOtlpCredential as rotateCredentialRecord,
} from "../db/otlp-credentials.js";
import { lockAuthorizedOrganization } from "../db/project-authorization.js";
import { pgPool } from "../db/postgres.js";
import { trustedTenant } from "../tenancy.js";
import {
	OtlpCredential,
	OtlpCredentialCreate,
	OtlpCredentialCreated,
	OtlpCredentialErrorResponses,
	OtlpCredentialIdParam,
	OtlpCredentialList,
	OtlpCredentialProjectQuery,
} from "../schemas/otlp-credentials.js";

const tag = "otlp-credentials";
const idResponse = {
	200: {
		description: "Credential metadata",
		content: { "application/json": { schema: OtlpCredential } },
	},
	...OtlpCredentialErrorResponses,
};
const secretResponse = {
	200: {
		description: "Rotated credential; secret shown once",
		content: { "application/json": { schema: OtlpCredentialCreated } },
	},
	...OtlpCredentialErrorResponses,
};

class CredentialRouteError extends Error {
	constructor(
		readonly code: "FORBIDDEN" | "NOT_FOUND",
		message: string,
	) {
		super(message);
	}
}

export const listOtlpCredentials = createRoute({
	method: "get",
	path: "/v1/admin/otlp-credentials",
	tags: [tag],
	summary: "List OTLP ingestion credentials for a Project",
	security: [{ basicAuth: [] }],
	request: { query: OtlpCredentialProjectQuery },
	responses: {
		200: {
			description: "Project credentials",
			content: { "application/json": { schema: OtlpCredentialList } },
		},
		...OtlpCredentialErrorResponses,
	},
});

export const createOtlpCredential = createRoute({
	method: "post",
	path: "/v1/admin/otlp-credentials",
	tags: [tag],
	summary: "Create a Project-bound OTLP ingestion credential",
	security: [{ basicAuth: [] }],
	request: {
		body: { content: { "application/json": { schema: OtlpCredentialCreate } } },
	},
	responses: {
		201: {
			description: "Credential secret, returned once",
			content: { "application/json": { schema: OtlpCredentialCreated } },
		},
		...OtlpCredentialErrorResponses,
	},
});

export const rotateOtlpCredential = createRoute({
	method: "post",
	path: "/v1/admin/otlp-credentials/{id}/rotate",
	tags: [tag],
	summary: "Rotate a Project-bound OTLP credential",
	security: [{ basicAuth: [] }],
	request: { params: OtlpCredentialIdParam, query: OtlpCredentialProjectQuery },
	responses: secretResponse,
});

export const revokeOtlpCredential = createRoute({
	method: "post",
	path: "/v1/admin/otlp-credentials/{id}/revoke",
	tags: [tag],
	summary: "Revoke a Project-bound OTLP credential",
	security: [{ basicAuth: [] }],
	request: { params: OtlpCredentialIdParam, query: OtlpCredentialProjectQuery },
	responses: idResponse,
});

async function adminProjectTransaction<T>(
	c: Context,
	projectId: string,
	allowArchived: boolean,
	work: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const tenant = trustedTenant(c);
	const client = await pgPool().connect();
	let open = false;
	try {
		await client.query("BEGIN");
		open = true;
		if (
			!(await lockAuthorizedOrganization(
				client,
				tenant.organizationId,
				tenant.actorId,
				"organization_manage",
			))
		)
			throw new CredentialRouteError(
				"FORBIDDEN",
				"Administration requires an Admin",
			);
		const project = await client.query(
			"SELECT id FROM projects WHERE id = $1 AND organization_id = $2 AND status = ANY($3::text[]) FOR UPDATE",
			[
				projectId,
				tenant.organizationId,
				allowArchived ? ["active", "archived"] : ["active"],
			],
		);
		if (!project.rows[0])
			throw new CredentialRouteError("NOT_FOUND", "Project is not available");
		const result = await work(client);
		await client.query("COMMIT");
		open = false;
		return result;
	} catch (cause) {
		if (open) await client.query("ROLLBACK").catch(() => {});
		throw cause;
	} finally {
		client.release();
	}
}

function publicCredential(
	credential: Awaited<
		ReturnType<typeof listCredentialRecords>
	>["items"][number],
) {
	return {
		id: credential.id,
		project_id: credential.project_id,
		name: credential.name,
		secret_prefix: credential.secret_prefix,
		created_by_actor_id: credential.created_by_actor_id,
		created_at: credential.created_at,
		rotated_at: credential.rotated_at,
		revoked_at: credential.revoked_at,
		last_used_at: credential.last_used_at,
	};
}

async function auditCredential(
	client: PoolClient,
	input: {
		organizationId: string;
		projectId: string;
		actorId: string;
		action: string;
	},
) {
	await client.query("SELECT audit_admin_access_event($1, $2, $3, NULL, $4)", [
		input.organizationId,
		input.projectId,
		input.actorId,
		input.action,
	]);
}

function failure(c: Context, cause: unknown): any {
	if (cause instanceof CredentialRouteError)
		return c.json(
			{ code: cause.code, message: cause.message },
			cause.code === "FORBIDDEN" ? 403 : 404,
		);
	if (cause instanceof OtlpCredentialNotFoundError)
		return c.json(
			{ code: "NOT_FOUND", message: "Credential is not available" },
			404,
		);
	return c.json(
		{ code: "INTERNAL", message: "Credential operation failed" },
		500,
	);
}

export const handleListOtlpCredentials: RouteHandler<
	typeof listOtlpCredentials
> = async (c) => {
	try {
		const tenant = trustedTenant(c);
		const { project_id } = c.req.valid("query");
		const result = await adminProjectTransaction(
			c,
			project_id,
			true,
			(client) =>
				listCredentialRecords(client, {
					organization_id: tenant.organizationId,
					project_id,
				}),
		);
		return c.json({ items: result.items.map(publicCredential) }, 200);
	} catch (cause) {
		return failure(c, cause);
	}
};

export const handleCreateOtlpCredential: RouteHandler<
	typeof createOtlpCredential
> = async (c) => {
	try {
		const tenant = trustedTenant(c);
		const body = c.req.valid("json");
		const result = await adminProjectTransaction(
			c,
			body.project_id,
			false,
			async (client) => {
				const created = await createCredentialRecord(client, {
					organization_id: tenant.organizationId,
					project_id: body.project_id,
					name: body.name,
					created_by_actor_id: tenant.actorId,
				});
				await auditCredential(client, {
					organizationId: tenant.organizationId,
					projectId: body.project_id,
					actorId: tenant.actorId,
					action: "project_otlp_credential_created",
				});
				return { ...created, credential: publicCredential(created.credential) };
			},
		);
		return c.json(result, 201);
	} catch (cause) {
		return failure(c, cause);
	}
};

export const handleRotateOtlpCredential: RouteHandler<
	typeof rotateOtlpCredential
> = async (c) => {
	try {
		const tenant = trustedTenant(c);
		const { id } = c.req.valid("param");
		const { project_id } = c.req.valid("query");
		const result = await adminProjectTransaction(
			c,
			project_id,
			false,
			async (client) => {
				const rotated = await rotateCredentialRecord(client, {
					organization_id: tenant.organizationId,
					project_id,
					id,
				});
				await auditCredential(client, {
					organizationId: tenant.organizationId,
					projectId: project_id,
					actorId: tenant.actorId,
					action: "project_otlp_credential_rotated",
				});
				return { ...rotated, credential: publicCredential(rotated.credential) };
			},
		);
		return c.json(result, 200);
	} catch (cause) {
		return failure(c, cause);
	}
};

export const handleRevokeOtlpCredential: RouteHandler<
	typeof revokeOtlpCredential
> = async (c) => {
	try {
		const tenant = trustedTenant(c);
		const { id } = c.req.valid("param");
		const { project_id } = c.req.valid("query");
		const result = await adminProjectTransaction(
			c,
			project_id,
			true,
			async (client) => {
				const revoked = await revokeCredentialRecord(client, {
					organization_id: tenant.organizationId,
					project_id,
					id,
				});
				await auditCredential(client, {
					organizationId: tenant.organizationId,
					projectId: project_id,
					actorId: tenant.actorId,
					action: "project_otlp_credential_revoked",
				});
				return publicCredential(revoked);
			},
		);
		return c.json(result, 200);
	} catch (cause) {
		return failure(c, cause);
	}
};
