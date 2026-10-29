import { z } from "@hono/zod-openapi";

const Id = z.string().uuid();

export const OtlpCredential = z.object({
	id: Id,
	project_id: Id,
	name: z.string(),
	secret_prefix: z.string(),
	created_by_actor_id: Id,
	created_at: z.string().datetime(),
	rotated_at: z.string().datetime().nullable(),
	revoked_at: z.string().datetime().nullable(),
	last_used_at: z.string().datetime().nullable(),
});

export const OtlpCredentialProjectQuery = z.object({ project_id: Id });
export const OtlpCredentialIdParam = z.object({ id: Id });
export const OtlpCredentialCreate = z.object({
	project_id: Id,
	name: z.string().trim().min(1).max(100),
});
export const OtlpCredentialList = z.object({ items: z.array(OtlpCredential) });
export const OtlpCredentialCreated = z.object({
	credential: OtlpCredential,
	secret: z.string().regex(/^gh_ing_[A-Za-z0-9_-]{43}$/),
});
export const OtlpCredentialError = z.object({
	code: z.enum([
		"BAD_REQUEST",
		"UNAUTHORIZED",
		"FORBIDDEN",
		"NOT_FOUND",
		"CONFLICT",
		"INTERNAL",
	]),
	message: z.string(),
});
export const OtlpCredentialErrorResponses = {
	400: {
		description: "Invalid request",
		content: { "application/json": { schema: OtlpCredentialError } },
	},
	403: {
		description: "Organization Admin required",
		content: { "application/json": { schema: OtlpCredentialError } },
	},
	404: {
		description: "Project or credential is not available",
		content: { "application/json": { schema: OtlpCredentialError } },
	},
	500: {
		description: "Credential operation failed",
		content: { "application/json": { schema: OtlpCredentialError } },
	},
};
