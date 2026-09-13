import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";
import { ProjectIdQuery } from "./prompts.js";

const Id = z.string().uuid();
export const BenchmarkSuite = z
	.object({
		id: Id,
		project_id: Id,
		dataset_id: Id,
		name: z.string(),
		description: z.string().nullable(),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
	})
	.strict()
	.openapi("BenchmarkSuite");
export const BenchmarkSuiteCreate = z
	.object({
		project_id: Id,
		dataset_id: Id,
		name: z.string().trim().min(1).max(120),
		description: z.string().trim().max(1000).nullable().optional(),
	})
	.strict()
	.openapi("BenchmarkSuiteCreate");
export const BenchmarkRun = z
	.object({
		id: Id,
		project_id: Id,
		suite_id: Id,
		experiment_id: Id,
		label: z.string(),
		model: z.string().nullable(),
		prompt_version: z.string().nullable(),
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("BenchmarkRun");
export const BenchmarkRunCreate = z
	.object({
		project_id: Id,
		evaluation_id: Id,
		definition_version: z.number().int().positive(),
		idempotency_key: z.string().trim().min(1).max(200),
		label: z.string().trim().min(1).max(160),
		prompt_version: z.string().trim().max(200).nullable().optional(),
		config: z.object({}).strict().default({}),
	})
	.strict()
	.openapi("BenchmarkRunCreate");
export const BenchmarkRanking = z
	.object({
		suite_id: Id,
		items: z.array(
			z
				.object({
					run_id: Id,
					experiment_id: Id,
					label: z.string(),
					model: z.string().nullable(),
					prompt_version: z.string().nullable(),
					pass_rate: z.number().min(0).max(1),
					total: z.number().int().nonnegative(),
					passed: z.number().int().nonnegative(),
					failed: z.number().int().nonnegative(),
					created_at: z.string().datetime(),
				})
				.strict(),
		),
	})
	.strict()
	.openapi("BenchmarkRanking");
export const BenchmarkSuiteIdParam = z.object({ id: Id }).strict();
export const BenchmarkProjectQuery = ProjectIdQuery;
export const BenchmarkErrorResponses = {
	400: {
		description: "Bad request",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description: "Benchmark not found",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	409: {
		description: "Benchmark conflict",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal server error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
export const BenchmarkRunAdmissionErrorResponses = {
	400: {
		description:
			"Unapproved provider/model pair, strict configuration validation, or requested sample-size/provider-call budget rejected before a runnable Run is persisted",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description:
			"Executable Evaluation Definition Version or benchmark suite not found",
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
