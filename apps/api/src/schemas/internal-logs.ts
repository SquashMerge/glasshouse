import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";

const InternalLogLevel = z.enum(["debug", "info", "warn", "error"]);
const Timestamp = z.string().datetime({ offset: true });

export const InternalLogQuery = z
	.object({
		limit: z.coerce.number().int().min(1).max(100).default(50),
		cursor: z.string().min(1).max(1024).optional(),
		level: InternalLogLevel.optional(),
		source: z.string().trim().min(1).max(80).optional(),
		q: z.string().trim().min(1).max(256).optional(),
		time_from: Timestamp.optional(),
		time_to: Timestamp.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.time_from && value.time_to && value.time_from > value.time_to)
			context.addIssue({
				code: "custom",
				message: "time_from must be before time_to",
				path: ["time_to"],
			});
	});

export const InternalLogEntry = z
	.object({
		id: z.string().uuid(),
		recorded_at: Timestamp,
		severity: InternalLogLevel,
		source: z.string(),
		message: z.string(),
		context: z.record(z.string(), z.unknown()),
	})
	.strict()
	.openapi("InternalLogEntry");

export const InternalLogList = z
	.object({
		items: z.array(InternalLogEntry),
		total: z.number().int().nonnegative(),
		next_cursor: z.string().optional(),
		sources: z.array(z.string()),
		retention_days: z.number().int().positive(),
	})
	.strict()
	.openapi("InternalLogList");

export const InternalLogErrorResponses = {
	400: {
		description: "Invalid query or cursor",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	401: {
		description: "Authentication required",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	403: {
		description: "Admin access required",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	503: {
		description: "Internal log collection is unavailable",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
