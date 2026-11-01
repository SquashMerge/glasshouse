import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";

const Filter = z.string().trim().min(1).max(200);

export const AuditLogQuery = z
	.object({
		limit: z.coerce.number().int().min(1).max(100).default(50),
		cursor: z.string().min(1).max(2048).optional(),
		from: z.string().datetime().optional(),
		to: z.string().datetime().optional(),
		actor: Filter.optional(),
		action: Filter.optional(),
		resource: Filter.optional(),
		outcome: Filter.optional(),
		search: Filter.optional(),
	})
	.strict()
	.refine((value) => !value.from || !value.to || value.from <= value.to, {
		message: "from must be before to",
		path: ["to"],
	});

export const AuditEvent = z
	.object({
		id: z.string().min(1),
		source: z.string().min(1),
		actor: z.string(),
		action: z.string().min(1),
		resource_type: z.string().min(1),
		resource_id: z.string().nullable(),
		outcome: z.string().nullable(),
		created_at: z.string().datetime(),
		details: z.object({ source: z.string().min(1) }).strict(),
	})
	.strict()
	.openapi("AuditEvent");

export const AuditEventList = z
	.object({
		items: z.array(AuditEvent),
		next_cursor: z.string().optional(),
	})
	.strict()
	.openapi("AuditEventList");

export const AuditLogErrorResponses = {
	400: {
		description: "Invalid request",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	401: {
		description: "Authentication required",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
