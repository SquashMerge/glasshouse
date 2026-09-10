import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";
import { ProjectIdQuery } from "./prompts.js";

const UUID_SHAPED_EVALUATION_IDENTIFIER =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EvaluationReservedSlugs = new Set(["compatibility"]);
const EvaluationIdentifier = z
	.string()
	.max(64)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
	.openapi({ example: "support-quality-gate" });
const Slug = EvaluationIdentifier.refine(
	(value) => !UUID_SHAPED_EVALUATION_IDENTIFIER.test(value),
	"Evaluation slug must not be UUID-shaped",
)
	.refine(
		(value) => !EvaluationReservedSlugs.has(value),
		"Evaluation slug is reserved",
	)
	.openapi({
		description:
			"Canonical Evaluation slug. UUID-shaped values and the reserved `compatibility` value are rejected when creating an Evaluation.",
		example: "support-quality-gate",
	});
const JsonPath = z
	.string()
	.regex(/^\$\.[A-Za-z0-9_.-]+$/)
	.max(128);
export const EvaluationEvaluator = z
	.object({
		kind: z.enum(["exact_match", "contains"]),
		version: z.literal("v1"),
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
export const EvaluationSampling = z
	.object({
		strategy: z.literal("first_n"),
		sample_size: z.number().int().min(1).max(10000),
		seed: z.number().int().min(0).max(2147483647),
	})
	.strict();
export const EvaluationLimits = z
	.object({
		max_cost_usd: z.number().positive().max(10000),
		max_duration_seconds: z.number().int().min(1).max(86400),
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
		sampling: EvaluationSampling,
		evaluator: EvaluationEvaluator,
		target: EvaluationTarget,
		execution_defaults: EvaluationExecutionDefaults,
		limits: EvaluationLimits,
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
		lifecycle_revision: z.number().int().positive(),
		archived_at: z.string().datetime().nullable(),
		tombstoned_at: z.string().datetime().nullable(),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
	})
	.strict()
	.openapi("Evaluation");
export const EvaluationCreate = z
	.object({
		slug: Slug,
		name: z.string().trim().min(1).max(120),
		description: z.string().trim().max(1000).nullable().optional(),
		definition: EvaluationDefinitionInput,
	})
	.strict()
	.openapi("EvaluationCreate");
const EvaluationDraftFields = {
	evaluation_id: z.string().uuid(),
	project_id: z.string().uuid(),
	revision: z.number().int().positive(),
	updated_at: z.string().datetime(),
};
export const EvaluationDraft = z
	.discriminatedUnion("definition_contract", [
		EvaluationDefinitionInput.extend({
			...EvaluationDraftFields,
			definition_contract: z.literal("v1"),
		}).strict(),
		z
			.object({
				...EvaluationDraftFields,
				definition_contract: z.literal("legacy_incomplete"),
				dataset_version_id: z.string().uuid(),
				sampling: z.record(z.string(), z.unknown()),
				evaluator: z.record(z.string(), z.unknown()),
				target: z.record(z.string(), z.unknown()),
				execution_defaults: z.record(z.string(), z.unknown()),
				limits: z.record(z.string(), z.unknown()),
				thresholds: z.record(z.string(), z.unknown()),
			})
			.strict(),
	])
	.openapi("EvaluationDraft");
const EvaluationDefinitionVersionFields = {
	id: z.string().uuid(),
	evaluation_id: z.string().uuid(),
	project_id: z.string().uuid(),
	version: z.number().int().positive(),
	content_hash: z.string().regex(/^[a-f0-9]{64}$/),
	published_by: z.string().uuid(),
	published_draft_revision: z.number().int().positive(),
	created_at: z.string().datetime(),
};
export const EvaluationDefinitionVersion = z
	.discriminatedUnion("definition_contract", [
		EvaluationDefinitionInput.extend({
			...EvaluationDefinitionVersionFields,
			definition_contract: z.literal("v1"),
		}).strict(),
		z
			.object({
				...EvaluationDefinitionVersionFields,
				definition_contract: z.literal("legacy_untyped"),
				dataset_version_id: z.string().uuid(),
				sampling: z.null(),
				evaluator: z.record(z.string(), z.unknown()),
				target: z.record(z.string(), z.unknown()),
				execution_defaults: z.record(z.string(), z.unknown()),
				limits: z.null(),
				thresholds: z.record(z.string(), z.unknown()),
			})
			.strict(),
	])
	.openapi("EvaluationDefinitionVersion");
export const EvaluationList = z
	.object({ items: z.array(Evaluation), total: z.number().int().nonnegative() })
	.strict()
	.openapi("EvaluationList");
export const EvaluationVersionList = z
	.object({ items: z.array(EvaluationDefinitionVersion) })
	.strict()
	.openapi("EvaluationVersionList");
export const EvaluationLegacyLink = z
	.object({
		legacy_kind: z.enum(["experiment", "benchmark_suite"]),
		legacy_id: z.string().uuid(),
		dataset_id: z.string().uuid().nullable(),
		compatibility: z.literal("legacy_ad_hoc"),
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("EvaluationLegacyLink");
export const EvaluationLegacyLinkList = z
	.object({ items: z.array(EvaluationLegacyLink) })
	.strict()
	.openapi("EvaluationLegacyLinkList");
export const EvaluationProjectQuery = ProjectIdQuery;
export const EvaluationListQuery = ProjectIdQuery.extend({
	include_archived: z
		.enum(["true", "false"])
		.optional()
		.default("false")
		.transform((value) => value === "true"),
}).strict();
export const EvaluationStatus = z
	.enum(["pending", "running", "completed", "failed", "cancelled"])
	.openapi("EvaluationStatus");
export const EvaluationTombstone = z
	.object({ confirmation_slug: EvaluationIdentifier })
	.strict();
export const EvaluationIdParam = z.object({ id: z.string().uuid() }).strict();
export const EvaluationRunStart = z
	.object({
		definition_version: z.number().int().positive(),
		trigger_metadata: z
			.record(
				z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
				z.union([
					z.string().max(200),
					z.number().finite(),
					z.boolean(),
					z.null(),
				]),
			)
			.default({}),
	})
	.strict()
	.openapi("EvaluationRunStart");
export const EvaluationRunHeaders = z.object({
	"idempotency-key": z
		.string()
		.trim()
		.min(1)
		.max(200)
		.openapi({
			param: { name: "idempotency-key", in: "header", required: true },
		}),
});
export const EvaluationRun = z
	.object({
		id: z.string().uuid(),
		organization_id: z.string().uuid(),
		project_id: z.string().uuid(),
		evaluation_id: z.string().uuid(),
		definition_version_id: z.string().uuid(),
		dataset_version_id: z.string().uuid(),
		dataset_id: z.string().uuid(),
		experiment_id: z.string().uuid(),
		benchmark_run_id: z.string().uuid().nullable(),
		status: EvaluationStatus,
		requested_by_actor_id: z.string().uuid(),
		idempotency_key: z.string(),
		request_hash: z.string().regex(/^[a-f0-9]{64}$/),
		resolved_inputs_hash: z.string().regex(/^[a-f0-9]{64}$/),
		trigger_metadata: z.record(z.string(), z.unknown()),
		snapshot: z.object({
			target: z.record(z.string(), z.unknown()),
			target_version: z.string(),
			target_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
			evaluator: z.record(z.string(), z.unknown()),
			evaluator_version: z.string(),
			execution_defaults: z.record(z.string(), z.unknown()),
			thresholds: z.record(z.string(), z.unknown()),
			sampling: z.record(z.string(), z.unknown()),
			sample_identity: z.string().regex(/^[a-f0-9]{64}$/),
			ordered_item_snapshot: z.array(z.record(z.string(), z.unknown())),
			resolved_inputs_hash: z.string().regex(/^[a-f0-9]{64}$/),
		}),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
		replayed: z.boolean(),
	})
	.strict()
	.openapi("EvaluationRun");

export const EvaluationSlugParam = z
	.object({
		slug: EvaluationIdentifier.openapi({
			param: { name: "slug", in: "path" },
			description:
				"Evaluation selector. Accepts a canonical slug or a UUID Evaluation ID for compatibility detail lookups.",
		}),
	})
	.strict();
export const EvaluationMutationSlugParam = z
	.object({
		slug: Slug.openapi({
			param: { name: "slug", in: "path" },
			description:
				"Canonical Evaluation slug. UUID Evaluation IDs are accepted only by read detail and inspection endpoints.",
		}),
	})
	.strict();
export const EvaluationVersionParam = EvaluationSlugParam.extend({
	version: z.coerce.number().int().positive(),
}).strict();
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
