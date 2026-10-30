import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";
import { ProjectIdQuery } from "./prompts.js";

const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const EvaluationGateContext = z.enum(["ci", "release"]);
export const EvaluationGateRunStatus = z.enum([
	"pending",
	"passed",
	"failed",
	"inconclusive",
	"error",
	"cancelled",
]);
export const EvaluationGateApprovalStatus = z.enum([
	"active",
	"revoked",
	"superseded",
]);
export const EvaluationGateApprovalCreate = z
	.object({
		definition_version_id: z.string().uuid(),
		gate_context: EvaluationGateContext,
		reason: z.string().trim().min(1).max(1000),
		supersedes_approval_id: z.string().uuid().nullable().optional(),
	})
	.strict()
	.openapi("EvaluationGateApprovalCreate");
export const EvaluationGateApprovalRevoke = z
	.object({ reason: z.string().trim().min(1).max(1000) })
	.strict()
	.openapi("EvaluationGateApprovalRevoke");
export const EvaluationGateApproval = z
	.object({
		id: z.string().uuid(),
		organization_id: z.string().uuid(),
		project_id: z.string().uuid(),
		evaluation_id: z.string().uuid(),
		definition_version_id: z.string().uuid(),
		definition_version: z.number().int().positive(),
		definition_contract: z.enum(["v1", "legacy_incompatible"]),
		dataset_version_id: z.string().uuid(),
		definition_content_hash: Fingerprint,
		dataset_content_hash: Fingerprint,
		gate_context: EvaluationGateContext,
		minimum_pass_rate: z.number().min(0).max(1),
		reason: z.string().max(1000),
		approved_by_actor_id: z.string().uuid(),
		approved_at: z.string().datetime(),
		revoked_at: z.string().datetime().nullable(),
		revoked_by_actor_id: z.string().uuid().nullable(),
		revocation_reason: z.string().max(1000).nullable(),
		superseded_by: z.string().uuid().nullable(),
		status: EvaluationGateApprovalStatus,
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("EvaluationGateApproval");
export const EvaluationGateApprovalListQuery = ProjectIdQuery.extend({
	include_revoked: z
		.enum(["true", "false"])
		.optional()
		.default("false")
		.transform((value) => value === "true"),
}).strict();
export const EvaluationGateApprovalList = z
	.object({
		items: z.array(EvaluationGateApproval),
		total: z.number().int().nonnegative(),
	})
	.strict()
	.openapi("EvaluationGateApprovalList");
export const EvaluationGateAuditEvent = z
	.object({
		id: z.string().uuid(),
		approval_id: z.string().uuid(),
		gate_run_id: z.string().uuid().nullable(),
		evaluation_run_id: z.string().uuid().nullable(),
		definition_version_id: z.string().uuid(),
		actor_id: z.string().uuid(),
		event_type: z.enum([
			"approved",
			"revoked",
			"superseded",
			"invoked",
			"outcome_recorded",
		]),
		gate_context: EvaluationGateContext.nullable(),
		outcome_status: EvaluationGateRunStatus.nullable(),
		reason_digest: Fingerprint.nullable(),
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("EvaluationGateAuditEvent");
export const EvaluationGateApprovalHistory = z
	.object({ items: z.array(EvaluationGateAuditEvent) })
	.strict()
	.openapi("EvaluationGateApprovalHistory");

export const EvaluationGateRunStart = z
	.object({
		approval_id: z.string().uuid(),
		definition_version_id: z.string().uuid(),
		dataset_version_id: z.string().uuid(),
		gate_context: EvaluationGateContext,
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
	.openapi("EvaluationGateRunStart");
export const EvaluationGateRunHeaders = z.object({
	"idempotency-key": z
		.string()
		.trim()
		.min(1)
		.max(200)
		.openapi({
			param: { name: "idempotency-key", in: "header", required: true },
		}),
});
export const EvaluationGateRun = z
	.object({
		id: z.string().uuid(),
		organization_id: z.string().uuid(),
		project_id: z.string().uuid(),
		approval_id: z.string().uuid(),
		evaluation_run_id: z.string().uuid(),
		evaluation_id: z.string().uuid(),
		definition_version_id: z.string().uuid(),
		dataset_version_id: z.string().uuid(),
		definition_content_hash: Fingerprint,
		dataset_content_hash: Fingerprint,
		target_fingerprint: Fingerprint,
		evaluator_fingerprint: Fingerprint,
		gate_context: EvaluationGateContext,
		minimum_pass_rate: z.number().min(0).max(1),
		selected_count: z.number().int().nonnegative().nullable(),
		evaluated_count: z.number().int().nonnegative().nullable(),
		passed_count: z.number().int().nonnegative().nullable(),
		failed_count: z.number().int().nonnegative().nullable(),
		status: EvaluationGateRunStatus,
		outcome_reason: z.string().max(256).nullable(),
		requested_by_actor_id: z.string().uuid(),
		idempotency_key: z.string(),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
	})
	.strict()
	.openapi("EvaluationGateRun");
export const EvaluationGateRunListQuery = ProjectIdQuery.extend({
	status: EvaluationGateRunStatus.optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	offset: z.coerce.number().int().min(0).optional().default(0),
}).strict();
export const EvaluationGateRunList = z
	.object({
		items: z.array(EvaluationGateRun),
		total: z.number().int().nonnegative(),
	})
	.strict()
	.openapi("EvaluationGateRunList");
export const EvaluationGateIdParam = z
	.object({ id: z.string().uuid() })
	.strict();
export const EvaluationGateErrorResponses = {
	400: {
		description: "Bad request",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	403: {
		description: "Administrator authorization required",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description: "Evaluation Gate not found",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	409: {
		description: "Evaluation Gate conflict",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal server error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
export const EvaluationGateRunAdmissionErrorResponses = {
	400: {
		description:
			"Unapproved provider/model pair, strict configuration validation, or requested sample-size/provider-call budget rejected before a runnable Run is persisted",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	403: {
		description: "Administrator authorization required",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description:
			"Active Evaluation Gate approval or executable Definition Version not found",
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
