import { z } from "@hono/zod-openapi";
import { ErrorEnvelope, NotImplementedError } from "./common.js";

export const Score = z
	.object({
		id: z.string().uuid(),
		project_id: z.string().uuid(),
		trace_id: z.string().nullable().optional(),
		experiment_id: z.string().uuid().nullable().optional(),
		name: z.string(),
		value: z.number(),
		metadata: z.record(z.string(), z.unknown()),
		created_at: z.string().datetime(),
	})
	.openapi("Score");

export const ScoreCreate = z
	.object({
		project_id: z.string().uuid(),
		trace_id: z.string().optional(),
		experiment_id: z.string().uuid().optional(),
		name: z.string().min(1).max(120),
		value: z.number(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.openapi("ScoreCreate");

export const ScoreStubResponses = {
	501: {
		description: "Not implemented",
		content: { "application/json": { schema: NotImplementedError } },
	},
	400: {
		description: "Bad request",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description: "Score not found",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
