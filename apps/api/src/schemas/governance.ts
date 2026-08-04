import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";

const Retention = z
	.object({
		traces: z.number().int().min(1).max(3650).optional(),
		datasets: z.number().int().min(1).max(3650).optional(),
		feedback: z.number().int().min(1).max(3650).optional(),
	})
	.strict();
const Redaction = z
	.object({
		mode: z.enum(["none", "all_text"]),
		keys: z.array(z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/)).max(64),
	})
	.strict();
export const PolicyInput = z.object({
	retention: Retention,
	redaction: Redaction,
});
export const PolicyVersion = z.object({
	id: z.string().uuid(),
	version: z.number().int(),
	retention: Retention,
	redaction: Redaction,
	content_hash: z.string(),
	created_by: z.string(),
	created_at: z.string(),
	approved_by: z.string().nullable(),
	approved_at: z.string().nullable(),
});
export const PolicyHistory = z.object({ items: z.array(PolicyVersion) });
export const EffectivePolicy = z.object({ policy: PolicyVersion.nullable() });
export const ProjectQuery = z.object({ project_id: z.string().uuid() });
export const PolicyMutation = PolicyInput.extend({
	project_id: z.string().uuid(),
});
export const RetentionSummary = z.object({
	policy_version_id: z.string().uuid(),
	counts: z.record(z.string(), z.number().int().nonnegative()),
	preview_id: z.string().uuid().optional(),
	preview_expires_at: z.string().datetime().optional(),
	run_id: z.string().uuid().optional(),
	status: z.enum(["completed", "failed"]).optional(),
});
export const RetentionRun = z.object({
	id: z.string().uuid(),
	policy_version_id: z.string().uuid(),
	status: z.enum(["running", "completed", "failed"]),
	counts: z.record(z.string(), z.number().int().nonnegative()),
	started_at: z.string(),
	completed_at: z.string().nullable(),
	duration_ms: z.number().int().nonnegative().nullable(),
});
export const RetentionRunHistory = z.object({ items: z.array(RetentionRun) });
export const GovernanceErrors = {
	400: {
		description: "Invalid request",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	403: {
		description: "Insufficient project role",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description: "Project is not available",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	409: {
		description: "Policy state conflict",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal server error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
