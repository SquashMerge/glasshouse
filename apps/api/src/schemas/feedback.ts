import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";

const FeedbackStatus = z.enum([
	"new",
	"reviewed",
	"dismissed",
	"added_to_dataset",
]);
const FeedbackSentiment = z.enum(["positive", "negative"]);
const TargetType = z.enum(["trace", "observation"]);

export const FeedbackCreate = z
	.object({
		project_id: z.string().uuid(),
		trace_id: z.string().regex(/^[0-9a-f]{32}$/),
		observation_id: z.string().min(1).max(128).optional(),
		value: z.union([z.literal(1), z.literal(-1)]),
		metadata: z
			.object({
				feedback: z
					.object({
						schema_version: z.literal(1),
						sentiment: FeedbackSentiment,
						reason: z.string().trim().min(1).max(120).optional(),
						comment: z.string().trim().max(2000).optional(),
					})
					.strict(),
			})
			.strict(),
	})
	.strict()
	.openapi("FeedbackCreate");

export const FeedbackReview = z
	.discriminatedUnion("status", [
		z
			.object({
				status: z.literal("added_to_dataset"),
				note: z.string().trim().max(2000).optional(),
				dataset_id: z.string().uuid(),
				dataset_item_id: z.string().uuid(),
			})
			.strict(),
		z
			.object({
				status: z.enum(["new", "reviewed", "dismissed"]),
				note: z.string().trim().max(2000).optional(),
			})
			.strict(),
	])
	.openapi("FeedbackReview");

export const FeedbackPromotion = z
	.object({
		dataset_id: z.string().uuid(),
		input: z.record(z.string(), z.unknown()),
		expected_output: z.record(z.string(), z.unknown()).nullable().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict()
	.openapi("FeedbackPromotion");

export const Feedback = z
	.object({
		id: z.string().uuid(),
		project_id: z.string().uuid(),
		trace_id: z.string(),
		observation_id: z.string().nullable(),
		target_type: TargetType,
		value: z.union([z.literal(1), z.literal(-1)]),
		sentiment: FeedbackSentiment,
		reason: z.string().nullable(),
		comment: z.string().nullable(),
		status: FeedbackStatus,
		note: z.string().nullable(),
		dataset_id: z.string().uuid().nullable(),
		dataset_item_id: z.string().uuid().nullable(),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
	})
	.strict()
	.openapi("Feedback");

export const FeedbackListQuery = z
	.object({
		project_id: z.string().uuid(),
		sentiment: FeedbackSentiment.optional(),
		status: FeedbackStatus.optional(),
		trace_id: z
			.string()
			.regex(/^[0-9a-f]{32}$/)
			.optional(),
		observation_id: z.string().max(128).optional(),
		target_type: TargetType.optional(),
		limit: z.coerce.number().int().min(1).max(100).default(50),
		offset: z.coerce.number().int().min(0).default(0),
	})
	.strict();

export const FeedbackIdParam = z.object({ id: z.string().uuid() }).strict();
export const FeedbackList = z
	.object({ items: z.array(Feedback), total: z.number().int().nonnegative() })
	.strict();
export const FeedbackErrors = {
	400: {
		description: "Bad request",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description: "Feedback target not found",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	409: {
		description: "Feedback conflict",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal server error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
