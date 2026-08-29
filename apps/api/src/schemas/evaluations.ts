import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";
import { ProjectIdQuery } from "./prompts.js";

const Slug = z
	.string()
	.max(64)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const JsonPath = z
	.string()
	.regex(/^\$\.[A-Za-z0-9_.-]+$/)
	.max(128);
export const EvaluationEvaluator = z
	.object({
		kind: z.enum(["exact_match", "contains"]),
		expected_output_path: JsonPath.default("$.expected_output"),
		output_path: JsonPath.default("$.output"),
	})
	.strict();
export const EvaluationTarget = z
	.object({
		kind: z.literal("configured_llm"),
		model: z.string().trim().min(1).max(200).nullable().default(null),
		system_prompt: z.string().max(16000).nullable().default(null),
	})
	.strict();
export const EvaluationExecutionDefaults = z
	.object({
		temperature: z.number().min(0).max(2).default(0),
		max_tokens: z.number().int().min(1).max(32768).nullable().default(null),
	})
	.strict();
export const EvaluationThresholds = z
	.object({
		minimum_pass_rate: z.number().min(0).max(1).nullable().default(null),
	})
	.strict();
export const EvaluationDefinitionInput = z
	.object({
		dataset_version_id: z.string().uuid(),
		evaluator: EvaluationEvaluator,
		target: EvaluationTarget,
		execution_defaults: EvaluationExecutionDefaults,
		thresholds: EvaluationThresholds,
	})
	.strict();
export const Evaluation = z
	.object({
		id: z.string().uuid(),
		project_id: z.string().uuid(),
		slug: Slug,
		name: z.string(),
		description: z.string().nullable(),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
	})
	.strict()
	.openapi("Evaluation");
export const EvaluationCreate = z
	.object({
		project_id: z.string().uuid(),
		slug: Slug,
		name: z.string().trim().min(1).max(120),
		description: z.string().trim().max(1000).nullable().optional(),
		definition: EvaluationDefinitionInput,
	})
	.strict()
	.openapi("EvaluationCreate");
export const EvaluationDraft = EvaluationDefinitionInput.extend({
	evaluation_id: z.string().uuid(),
	project_id: z.string().uuid(),
	revision: z.number().int().positive(),
	updated_at: z.string().datetime(),
})
	.strict()
	.openapi("EvaluationDraft");
export const EvaluationDefinitionVersion = EvaluationDefinitionInput.extend({
	id: z.string().uuid(),
	evaluation_id: z.string().uuid(),
	project_id: z.string().uuid(),
	version: z.number().int().positive(),
	content_hash: z.string().regex(/^[a-f0-9]{64}$/),
	published_draft_revision: z.number().int().positive(),
	created_at: z.string().datetime(),
})
	.strict()
	.openapi("EvaluationDefinitionVersion");
export const EvaluationList = z
	.object({ items: z.array(Evaluation), total: z.number().int().nonnegative() })
	.strict()
	.openapi("EvaluationList");
export const EvaluationVersionList = z
	.object({ items: z.array(EvaluationDefinitionVersion) })
	.strict()
	.openapi("EvaluationVersionList");
export const EvaluationProjectQuery = ProjectIdQuery;
export const EvaluationIdParam = z.object({ id: z.string().uuid() }).strict();
export const EvaluationErrorResponses = {
	400: {
		description: "Bad request",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description: "Evaluation not found",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	409: {
		description: "Evaluation conflict",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal server error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
