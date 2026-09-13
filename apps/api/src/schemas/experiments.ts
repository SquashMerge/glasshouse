import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";
import { ProjectIdQuery } from "./prompts.js";

export const ExperimentStatus = z
	.enum(["pending", "running", "completed", "failed", "cancelled"])
	.openapi("ExperimentStatus");
export const Experiment = z
	.object({
		id: z.string().uuid(),
		project_id: z.string().uuid(),
		agent_id: z.string().uuid().nullable(),
		dataset_id: z.string().uuid(),
		resolved_dataset_version_id: z.string().uuid().nullable(),
		dataset_input_binding: z.enum(["versioned", "legacy_unversioned"]),
		name: z.string().nullable(),
		status: ExperimentStatus,
		config: z.record(z.string(), z.unknown()),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
	})
	.strict()
	.openapi("Experiment");
export const ExperimentCreate = z
	.object({
		project_id: z.string().uuid(),
		evaluation_id: z.string().uuid(),
		definition_version: z.number().int().positive(),
		idempotency_key: z.string().trim().min(1).max(200),
		agent_id: z.string().uuid().nullable().optional(),
		dataset_id: z.string().uuid(),
		name: z.string().trim().max(120).nullable().optional(),
	})
	.strict()
	.openapi("ExperimentCreate");
export const ExperimentList = z
	.object({ items: z.array(Experiment), total: z.number().int().nonnegative() })
	.strict()
	.openapi("ExperimentList");
export const ExperimentResult = z
	.object({
		id: z.string().uuid(),
		experiment_id: z.string().uuid(),
		dataset_item_id: z.string().uuid(),
		agent_version: z.string().nullable(),
		output: z.record(z.string(), z.unknown()).nullable(),
		scores: z.record(z.string(), z.number()),
		duration_ms: z.number().int().nullable(),
		cost_usd: z.number().nonnegative().nullable(),
		error_classification: z.string().max(128).nullable(),
		error_message: z.string().max(512).nullable(),
		evaluator_rationale: z.record(z.string(), z.unknown()).nullable(),
		trace_id: z.string().max(256).nullable(),
		status: ExperimentStatus,
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("ExperimentResult");
export const ExperimentResults = z
	.object({
		experiment_id: z.string().uuid(),
		items: z.array(ExperimentResult),
	})
	.strict()
	.openapi("ExperimentResults");
export const ExperimentSummary = z
	.object({
		experiment_id: z.string().uuid(),
		total: z.number().int(),
		passed: z.number().int(),
		failed: z.number().int(),
		pass_rate: z.number().min(0).max(1),
		avg_duration_ms: z.number().nullable(),
	})
	.strict()
	.openapi("ExperimentSummary");
export const ExperimentProjectQuery = ProjectIdQuery;
export const ExperimentIdParam = z
	.object({ id: z.string().uuid() })
	.openapi("ExperimentIdParam");
export const ExperimentErrorResponses = {
	400: {
		description: "Bad request",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description: "Experiment not found",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	409: {
		description: "Experiment conflict",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal server error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
export const ExperimentRunAdmissionErrorResponses = {
	400: {
		description:
			"Unapproved provider/model pair, strict configuration validation, or case/provider-call budget rejected before a runnable Run is persisted",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description: "Executable Evaluation Definition Version not found",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	409: {
		description:
			"Run-start conflict, including an Idempotency-Key bound to a different immutable request",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	429: {
		description:
			"Active project or actor capacity is exhausted; no runnable Run is persisted",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal server error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
