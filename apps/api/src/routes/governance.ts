import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { pgPool } from "../db/postgres.js";
import {
	policyHash,
	retentionCounts,
	validatePolicy,
} from "../db/governance.js";
import {
	GovernanceErrors,
	EffectivePolicy,
	PolicyHistory,
	PolicyMutation,
	ProjectQuery,
	RetentionSummary,
} from "../schemas/governance.js";
import { trustedTenant } from "../tenancy.js";
import { logger } from "../lib/logger.js";

const policyParams = z.object({ id: z.string().uuid() });
const ok = (schema: z.ZodType) => ({
	200: { description: "OK", content: { "application/json": { schema } } },
	...GovernanceErrors,
});
export const getEffectivePolicy = createRoute({
	method: "get",
	path: "/v1/governance/policy",
	tags: ["governance"],
	security: [{ basicAuth: [] }],
	request: { query: ProjectQuery },
	responses: ok(EffectivePolicy),
});
export const listPolicyHistory = createRoute({
	method: "get",
	path: "/v1/governance/policy/history",
	tags: ["governance"],
	security: [{ basicAuth: [] }],
	request: { query: ProjectQuery },
	responses: ok(PolicyHistory),
});
export const createPolicyDraft = createRoute({
	method: "post",
	path: "/v1/governance/policy/drafts",
	tags: ["governance"],
	security: [{ basicAuth: [] }],
	request: {
		body: { content: { "application/json": { schema: PolicyMutation } } },
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: EffectivePolicy } },
		},
		...GovernanceErrors,
	},
});
export const approvePolicy = createRoute({
	method: "post",
	path: "/v1/governance/policy/{id}/approve",
	tags: ["governance"],
	security: [{ basicAuth: [] }],
	request: { params: policyParams, query: ProjectQuery },
	responses: ok(EffectivePolicy),
});
const previewBody = z.object({ project_id: z.string().uuid() });
const runBody = z.object({
	project_id: z.string().uuid(),
	batch_size: z.number().int().min(1).max(500).default(100),
});
export const previewRetention = createRoute({
	method: "post",
	path: "/v1/governance/retention/preview",
	tags: ["governance"],
	security: [{ basicAuth: [] }],
	request: {
		body: { content: { "application/json": { schema: previewBody } } },
	},
	responses: ok(RetentionSummary),
});
export const runRetention = createRoute({
	method: "post",
	path: "/v1/governance/retention/runs",
	tags: ["governance"],
	security: [{ basicAuth: [] }],
	request: { body: { content: { "application/json": { schema: runBody } } } },
	responses: ok(RetentionSummary),
});

type VersionRow = {
	id: string;
	version: number;
	retention: Record<string, number>;
	redaction: { mode: "none" | "all_text"; keys: string[] };
	content_hash: string;
	created_by: string;
	created_at: Date;
	approved_by: string | null;
	approved_at: Date | null;
};
const output = (row: VersionRow) => ({
	...row,
	created_at: row.created_at.toISOString(),
	approved_at: row.approved_at?.toISOString() ?? null,
});
async function manager(c: Context, projectId: string) {
	const tenant = trustedTenant(c);
	const result = await pgPool().query<{ role: string | null }>(
		"SELECT CASE WHEN om.role = 'owner' THEN 'owner' ELSE pm.role END AS role FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND om.actor_subject = $3 LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.actor_subject = $3 WHERE p.id = $1 AND p.organization_id = $2 AND p.status = 'active'",
		[projectId, tenant.organizationId, tenant.actor],
	);
	if (!result.rows[0]?.role) throw new Error("Not found");
	if (!["owner", "manager"].includes(result.rows[0].role))
		throw new Error("Forbidden");
	return tenant;
}
async function versions(projectId: string, organizationId: string) {
	return pgPool().query<VersionRow>(
		"SELECT v.id, v.version, v.retention, v.redaction, v.content_hash, v.created_by, v.created_at, a.actor_subject AS approved_by, a.approved_at FROM governance_policy_versions v JOIN governance_policies p ON p.id = v.policy_id LEFT JOIN governance_policy_approvals a ON a.policy_version_id = v.id WHERE p.project_id = $1 AND p.organization_id = $2 ORDER BY v.version DESC",
		[projectId, organizationId],
	);
}
function failure(c: Context, cause: unknown) {
	const message =
		cause instanceof Error ? cause.message : "Governance operation failed";
	if (message === "Not found")
		return c.json(
			{ code: "NOT_FOUND", message: "Project is not available" },
			404,
		);
	if (message === "Forbidden")
		return c.json({ code: "FORBIDDEN", message }, 403);
	if (message.includes("Unsupported") || message.includes("must be"))
		return c.json(
			{ code: "BAD_REQUEST", message: "Request validation failed" },
			400,
		);
	if (message.includes("approved"))
		return c.json({ code: "CONFLICT", message }, 409);
	logger.error("governance.operation_failed", cause);
	return c.json(
		{ code: "INTERNAL", message: "Governance operation failed" },
		500,
	);
}
export async function handleGetEffectivePolicy(c: Context) {
	try {
		const { project_id } = (c.req as any).valid("query");
		const tenant = await manager(c, project_id);
		const row =
			(await versions(project_id, tenant.organizationId)).rows.find(
				(version) => version.approved_at,
			) ?? null;
		return c.json({ policy: row ? output(row) : null });
	} catch (cause) {
		return failure(c, cause);
	}
}
export async function handleListPolicyHistory(c: Context) {
	try {
		const { project_id } = (c.req as any).valid("query");
		const tenant = await manager(c, project_id);
		return c.json({
			items: (await versions(project_id, tenant.organizationId)).rows.map(
				output,
			),
		});
	} catch (cause) {
		return failure(c, cause);
	}
}
export async function handleCreatePolicyDraft(c: Context) {
	try {
		const { project_id, ...input } = (c.req as any).valid("json");
		const tenant = await manager(c, project_id);
		const policy = validatePolicy(input);
		const hash = policyHash(policy);
		const db = pgPool();
		const existing = await db.query<VersionRow>(
			"SELECT v.id, v.version, v.retention, v.redaction, v.content_hash, v.created_by, v.created_at, a.actor_subject AS approved_by, a.approved_at FROM governance_policy_versions v JOIN governance_policies p ON p.id = v.policy_id LEFT JOIN governance_policy_approvals a ON a.policy_version_id = v.id WHERE p.project_id = $1 AND p.organization_id = $2 AND v.content_hash = $3",
			[project_id, tenant.organizationId, hash],
		);
		if (existing.rows[0])
			return c.json({ policy: output(existing.rows[0]) }, 201);
		const created = await db.query<VersionRow>(
			"WITH p AS (INSERT INTO governance_policies (organization_id, project_id) VALUES ($1, $2) ON CONFLICT (project_id) DO UPDATE SET project_id = EXCLUDED.project_id RETURNING id), v AS (INSERT INTO governance_policy_versions (policy_id, organization_id, project_id, version, retention, redaction, content_hash, created_by) SELECT p.id, $1, $2, COALESCE((SELECT max(version) + 1 FROM governance_policy_versions WHERE policy_id = p.id), 1), $3::jsonb, $4::jsonb, $5, $6 FROM p RETURNING *) INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type) SELECT $1, $2, v.id, $6, 'policy_created' FROM v RETURNING (SELECT id FROM v) AS id, (SELECT version FROM v) AS version, $3::jsonb AS retention, $4::jsonb AS redaction, $5 AS content_hash, $6 AS created_by, now() AS created_at, NULL::text AS approved_by, NULL::timestamptz AS approved_at",
			[
				tenant.organizationId,
				project_id,
				JSON.stringify(policy.retention),
				JSON.stringify(policy.redaction),
				hash,
				tenant.actor,
			],
		);
		return c.json({ policy: output(created.rows[0]!) }, 201);
	} catch (cause) {
		return failure(c, cause);
	}
}
export async function handleApprovePolicy(c: Context) {
	try {
		const { id } = (c.req as any).valid("param");
		const { project_id } = (c.req as any).valid("query");
		const tenant = await manager(c, project_id);
		const db = pgPool();
		const version = (
			await db.query<VersionRow>(
				"SELECT v.id, v.version, v.retention, v.redaction, v.content_hash, v.created_by, v.created_at, NULL::text AS approved_by, NULL::timestamptz AS approved_at FROM governance_policy_versions v JOIN governance_policies p ON p.id = v.policy_id WHERE v.id = $1 AND p.project_id = $2 AND p.organization_id = $3",
				[id, project_id, tenant.organizationId],
			)
		).rows[0];
		if (!version) throw new Error("Not found");
		const approval = await db.query(
			"INSERT INTO governance_policy_approvals (policy_version_id, organization_id, project_id, actor_subject) VALUES ($1, $2, $3, $4) ON CONFLICT (policy_version_id) DO NOTHING RETURNING approved_at",
			[id, tenant.organizationId, project_id, tenant.actor],
		);
		if (!approval.rows[0]) throw new Error("Policy is already approved");
		await db.query(
			"INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type) VALUES ($1, $2, $3, $4, 'policy_approved')",
			[tenant.organizationId, project_id, id, tenant.actor],
		);
		return c.json({
			policy: output({
				...version,
				approved_by: tenant.actor,
				approved_at: approval.rows[0].approved_at,
			}),
		});
	} catch (cause) {
		return failure(c, cause);
	}
}
async function approved(c: Context, projectId: string) {
	const tenant = await manager(c, projectId);
	const version = (await versions(projectId, tenant.organizationId)).rows.find(
		(row) => row.approved_at,
	);
	if (!version) throw new Error("No approved policy exists");
	return { tenant, version };
}
export async function handlePreviewRetention(c: Context) {
	try {
		const { project_id } = (c.req as any).valid("json");
		const { tenant, version } = await approved(c, project_id);
		const counts = await retentionCounts(
			pgPool(),
			tenant.organizationId,
			project_id,
			version.retention,
		);
		await pgPool().query(
			"INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type, counts) VALUES ($1, $2, $3, $4, 'retention_previewed', $5::jsonb)",
			[
				tenant.organizationId,
				project_id,
				version.id,
				tenant.actor,
				JSON.stringify(counts),
			],
		);
		return c.json({ policy_version_id: version.id, counts });
	} catch (cause) {
		return failure(c, cause);
	}
}
export async function handleRunRetention(c: Context) {
	try {
		const { project_id, batch_size } = (c.req as any).valid("json");
		const { tenant, version } = await approved(c, project_id);
		const started = performance.now();
		const db = pgPool();
		const run = await db.query<{ id: string }>(
			"INSERT INTO governance_retention_runs (organization_id, project_id, policy_version_id, requested_by, status) VALUES ($1, $2, $3, $4, 'running') RETURNING id",
			[tenant.organizationId, project_id, version.id, tenant.actor],
		);
		const counts: Record<string, number> = {};
		for (const [dataClass, days] of Object.entries(version.retention)) {
			const cutoff = new Date(Date.now() - days * 86_400_000);
			if (dataClass === "datasets") {
				const result = await db.query<{ id: string }>(
					"DELETE FROM datasets WHERE id IN (SELECT id FROM datasets WHERE project_id = $1 AND created_at < $2 ORDER BY created_at LIMIT $3) RETURNING id",
					[project_id, cutoff, batch_size],
				);
				counts.datasets = result.rows.length;
			}
			if (dataClass === "feedback") {
				const result = await db.query<{ score_id: string }>(
					"DELETE FROM feedback_reviews WHERE score_id IN (SELECT score_id FROM feedback_reviews WHERE project_id = $1 AND created_at < $2 ORDER BY created_at LIMIT $3) RETURNING score_id",
					[project_id, cutoff, batch_size],
				);
				counts.feedback = result.rows.length;
			}
			if (dataClass === "traces") {
				await (await import("../db/clickhouse.js")).ch().command({
					query:
						"ALTER TABLE observations DELETE WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} AND start_time < {cutoff:DateTime64(3)} SETTINGS mutations_sync = 1",
					query_params: {
						organizationId: tenant.organizationId,
						projectId: project_id,
						cutoff: cutoff.toISOString(),
					},
				});
				await (await import("../db/clickhouse.js")).ch().command({
					query:
						"ALTER TABLE traces DELETE WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} AND start_time < {cutoff:DateTime64(3)} SETTINGS mutations_sync = 1",
					query_params: {
						organizationId: tenant.organizationId,
						projectId: project_id,
						cutoff: cutoff.toISOString(),
					},
				});
				counts.traces = 0;
			}
		}
		const duration = Math.round(performance.now() - started);
		await db.query(
			"UPDATE governance_retention_runs SET status = 'completed', counts = $2::jsonb, completed_at = now() WHERE id = $1",
			[run.rows[0]!.id, JSON.stringify(counts)],
		);
		await db.query(
			"INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type, counts, duration_ms) VALUES ($1, $2, $3, $4, 'retention_completed', $5::jsonb, $6)",
			[
				tenant.organizationId,
				project_id,
				version.id,
				tenant.actor,
				JSON.stringify(counts),
				duration,
			],
		);
		logger.info("governance.retention_completed", {
			project_id,
			run_id: run.rows[0]!.id,
			duration_ms: duration,
			counts,
		});
		return c.json({
			policy_version_id: version.id,
			counts,
			run_id: run.rows[0]!.id,
			status: "completed",
		});
	} catch (cause) {
		return failure(c, cause);
	}
}
