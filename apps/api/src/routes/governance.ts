import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Pool, PoolClient } from "pg";
import { pgPool } from "../db/postgres.js";
import {
	policyHash,
	deleteSafeDatasetRetentionBatch,
	deleteTraceRetentionBatch,
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
	RetentionRunHistory,
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
	policy_version_id: z.string().uuid(),
	preview_id: z.string().uuid(),
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
export const listRetentionRuns = createRoute({
	method: "get",
	path: "/v1/governance/retention/runs",
	tags: ["governance"],
	security: [{ basicAuth: [] }],
	request: { query: ProjectQuery },
	responses: ok(RetentionRunHistory),
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
	if (
		message.includes("approved") ||
		message.includes("stale") ||
		message.includes("preview") ||
		message.includes("running") ||
		message.includes("no longer active") ||
		message.includes("revoked")
	)
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
		const client = await pgPool().connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"INSERT INTO governance_policies (organization_id, project_id) VALUES ($1, $2) ON CONFLICT (project_id) DO NOTHING",
				[tenant.organizationId, project_id],
			);
			const policyRow = await client.query<{ id: string }>(
				"SELECT id FROM governance_policies WHERE organization_id = $1 AND project_id = $2 FOR UPDATE",
				[tenant.organizationId, project_id],
			);
			const policyId = policyRow.rows[0]?.id;
			if (!policyId) throw new Error("Not found");
			const existing = await client.query<VersionRow>(
				"SELECT v.id, v.version, v.retention, v.redaction, v.content_hash, v.created_by, v.created_at, NULL::text AS approved_by, NULL::timestamptz AS approved_at FROM governance_policy_versions v WHERE v.policy_id = $1 AND v.content_hash = $2",
				[policyId, hash],
			);
			if (existing.rows[0]) {
				await client.query("COMMIT");
				return c.json({ policy: output(existing.rows[0]) }, 201);
			}
			const created = await client.query<VersionRow>(
				"INSERT INTO governance_policy_versions (policy_id, organization_id, project_id, version, retention, redaction, content_hash, created_by) SELECT $1, $2, $3, COALESCE(max(version) + 1, 1), $4::jsonb, $5::jsonb, $6, $7 FROM governance_policy_versions WHERE policy_id = $1 RETURNING id, version, retention, redaction, content_hash, created_by, created_at, NULL::text AS approved_by, NULL::timestamptz AS approved_at",
				[
					policyId,
					tenant.organizationId,
					project_id,
					JSON.stringify(policy.retention),
					JSON.stringify(policy.redaction),
					hash,
					tenant.actor,
				],
			);
			await client.query(
				"INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type) VALUES ($1, $2, $3, $4, 'policy_created')",
				[tenant.organizationId, project_id, created.rows[0]!.id, tenant.actor],
			);
			await client.query("COMMIT");
			return c.json({ policy: output(created.rows[0]!) }, 201);
		} catch (cause) {
			await client.query("ROLLBACK").catch(() => {});
			throw cause;
		} finally {
			client.release();
		}
	} catch (cause) {
		return failure(c, cause);
	}
}
export async function handleApprovePolicy(c: Context) {
	try {
		const { id } = (c.req as any).valid("param");
		const { project_id } = (c.req as any).valid("query");
		const tenant = await manager(c, project_id);
		const client = await pgPool().connect();
		try {
			await client.query("BEGIN");
			const authorized = await client.query(
				"SELECT p.id FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND om.actor_subject = $3 LEFT JOIN LATERAL (SELECT role FROM project_memberships WHERE project_id = p.id AND actor_subject = $3 FOR UPDATE) pm ON true WHERE p.id = $1 AND p.organization_id = $2 AND p.status = 'active' AND (om.role = 'owner' OR pm.role = 'manager') FOR UPDATE OF p, om",
				[project_id, tenant.organizationId, tenant.actor],
			);
			if (!authorized.rows[0]) throw new Error("Not found");
			const version = (
				await client.query<VersionRow>(
					"SELECT v.id, v.version, v.retention, v.redaction, v.content_hash, v.created_by, v.created_at, NULL::text AS approved_by, NULL::timestamptz AS approved_at FROM governance_policy_versions v JOIN governance_policies p ON p.id = v.policy_id WHERE v.id = $1 AND p.project_id = $2 AND p.organization_id = $3",
					[id, project_id, tenant.organizationId],
				)
			).rows[0];
			if (!version) throw new Error("Not found");
			const approval = await client.query(
				"INSERT INTO governance_policy_approvals (policy_version_id, organization_id, project_id, actor_subject) VALUES ($1, $2, $3, $4) ON CONFLICT (policy_version_id) DO NOTHING RETURNING approved_at",
				[id, tenant.organizationId, project_id, tenant.actor],
			);
			if (!approval.rows[0]) throw new Error("Policy is already approved");
			await client.query(
				"INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type) VALUES ($1, $2, $3, $4, 'policy_approved')",
				[tenant.organizationId, project_id, id, tenant.actor],
			);
			await client.query("COMMIT");
			return c.json({
				policy: output({
					...version,
					approved_by: tenant.actor,
					approved_at: approval.rows[0].approved_at,
				}),
			});
		} catch (cause) {
			await client.query("ROLLBACK").catch(() => {});
			throw cause;
		} finally {
			client.release();
		}
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
		const client = await pgPool().connect();
		try {
			await client.query("BEGIN");
			const current = await activeManagerAndVersion(
				client,
				tenant.organizationId,
				project_id,
				tenant.actor,
			);
			if (current.id !== version.id) throw new Error("Policy preview is stale");
			const preview = await client.query<{ id: string; expires_at: Date }>(
				"INSERT INTO governance_retention_previews (organization_id, project_id, policy_version_id, actor_subject, counts, expires_at) VALUES ($1, $2, $3, $4, $5::jsonb, now() + interval '15 minutes') RETURNING id, expires_at",
				[
					tenant.organizationId,
					project_id,
					version.id,
					tenant.actor,
					JSON.stringify(counts),
				],
			);
			await client.query(
				"INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type, counts) VALUES ($1, $2, $3, $4, 'retention_previewed', $5::jsonb)",
				[
					tenant.organizationId,
					project_id,
					version.id,
					tenant.actor,
					JSON.stringify(counts),
				],
			);
			await client.query("COMMIT");
			return c.json({
				policy_version_id: version.id,
				counts,
				preview_id: preview.rows[0]!.id,
				preview_expires_at: preview.rows[0]!.expires_at.toISOString(),
			});
		} catch (cause) {
			await client.query("ROLLBACK").catch(() => {});
			throw cause;
		} finally {
			client.release();
		}
	} catch (cause) {
		return failure(c, cause);
	}
}
export async function handleListRetentionRuns(c: Context) {
	try {
		const { project_id } = (c.req as any).valid("query");
		const tenant = await manager(c, project_id);
		const result = await pgPool().query<{
			id: string;
			policy_version_id: string;
			status: "running" | "completed" | "failed";
			counts: Record<string, number>;
			started_at: Date;
			completed_at: Date | null;
			duration_ms: number | null;
		}>(
			"SELECT id, policy_version_id, status, counts, started_at, completed_at, CASE WHEN completed_at IS NULL THEN NULL ELSE GREATEST(0, round(EXTRACT(epoch FROM completed_at - started_at) * 1000)::integer) END AS duration_ms FROM governance_retention_runs WHERE organization_id = $1 AND project_id = $2 ORDER BY started_at DESC, id DESC LIMIT 50",
			[tenant.organizationId, project_id],
		);
		return c.json({
			items: result.rows.map((run) => ({
				...run,
				started_at: run.started_at.toISOString(),
				completed_at: run.completed_at?.toISOString() ?? null,
			})),
		});
	} catch (cause) {
		return failure(c, cause);
	}
}
export async function handleRunRetention(c: Context) {
	try {
		const { project_id, policy_version_id, preview_id, batch_size } = (
			c.req as any
		).valid("json");
		const tenant = await manager(c, project_id);
		const started = performance.now();
		const db = pgPool();
		const client = await db.connect();
		let runId = "";
		let startedCommitted = false;
		let version: VersionRow;
		const counts: Record<string, number> = {};
		try {
			await client.query("BEGIN");
			version = await activeManagerAndVersion(
				client,
				tenant.organizationId,
				project_id,
				tenant.actor,
			);
			if (version.id !== policy_version_id)
				throw new Error("Policy preview is stale");
			const consumed = await client.query(
				"UPDATE governance_retention_previews SET consumed_at = now() WHERE id = $1 AND organization_id = $2 AND project_id = $3 AND policy_version_id = $4 AND actor_subject = $5 AND consumed_at IS NULL AND expires_at > now() RETURNING id",
				[
					preview_id,
					tenant.organizationId,
					project_id,
					version.id,
					tenant.actor,
				],
			);
			if (!consumed.rows[0])
				throw new Error(
					"Retention preview is absent, expired, or already used",
				);
			const run = await client.query<{ id: string }>(
				"INSERT INTO governance_retention_runs (organization_id, project_id, policy_version_id, requested_by, status) VALUES ($1, $2, $3, $4, 'running') RETURNING id",
				[tenant.organizationId, project_id, version.id, tenant.actor],
			);
			runId = run.rows[0]!.id;
			await client.query(
				"INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type) VALUES ($1, $2, $3, $4, 'retention_started')",
				[tenant.organizationId, project_id, version.id, tenant.actor],
			);
			await client.query("COMMIT");
			startedCommitted = true;
		} catch (cause: any) {
			if (cause?.code === "23505")
				throw new Error("A retention run is already running");
			throw cause;
		} finally {
			if (!startedCommitted) await client.query("ROLLBACK").catch(() => {});
			client.release();
		}
		try {
			const feedbackDays = version.retention.feedback;
			const feedbackCutoff = feedbackDays
				? new Date(Date.now() - feedbackDays * 86_400_000)
				: undefined;
			if (feedbackCutoff) {
				await destructiveStage(
					db,
					tenant,
					project_id,
					version,
					runId,
					"feedback",
					async (stage) => {
						counts.feedback = await deleteFeedbackRetentionBatch(
							stage,
							project_id,
							feedbackCutoff,
							batch_size,
						);
					},
					counts,
				);
			}
			if (version.retention.datasets) {
				const cutoff = new Date(
					Date.now() - version.retention.datasets * 86_400_000,
				);
				const result = (await destructiveStage(
					db,
					tenant,
					project_id,
					version,
					runId,
					"datasets",
					async (stage) => {
						const deleted = await deleteSafeDatasetRetentionBatch(
							stage,
							project_id,
							cutoff,
							batch_size,
							feedbackCutoff,
						);
						counts.datasets = deleted.deleted;
						counts.datasets_skipped = deleted.skipped;
						return deleted;
					},
					counts,
				)) as { deleted: number; skipped: number };
				counts.datasets = result.deleted;
				counts.datasets_skipped = result.skipped;
			}
			if (version.retention.traces) {
				const cutoff = new Date(
					Date.now() - version.retention.traces * 86_400_000,
				);
				await destructiveStage(
					db,
					tenant,
					project_id,
					version,
					runId,
					"traces",
					async () => {
						counts.traces = await deleteTraceRetentionBatch(
							tenant.organizationId,
							project_id,
							cutoff,
							batch_size,
						);
					},
					counts,
				);
			}
			const duration = Math.round(performance.now() - started);
			await withRunTransaction(db, async (stage) => {
				await stage.query(
					"UPDATE governance_retention_runs SET status = 'completed', counts = $2::jsonb, cursor = jsonb_build_object('stage', 'completed'), completed_at = now() WHERE id = $1 AND status = 'running'",
					[runId, JSON.stringify(counts)],
				);
				await stage.query(
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
			});
			logger.info("governance.retention_completed", {
				project_id,
				run_id: runId,
				duration_ms: duration,
				counts,
			});
			return c.json({
				policy_version_id: version.id,
				counts,
				run_id: runId,
				status: "completed",
			});
		} catch (cause) {
			const duration = Math.round(performance.now() - started);
			await withRunTransaction(db, async (stage) => {
				await stage.query(
					"UPDATE governance_retention_runs SET status = 'failed', counts = $2::jsonb, completed_at = now() WHERE id = $1 AND status = 'running'",
					[runId, JSON.stringify(counts)],
				);
				await stage.query(
					"INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type, counts, duration_ms) VALUES ($1, $2, $3, $4, 'retention_failed', $5::jsonb, $6)",
					[
						tenant.organizationId,
						project_id,
						version.id,
						tenant.actor,
						JSON.stringify(counts),
						duration,
					],
				);
			}).catch(() => {});
			logger.error("governance.retention_failed", cause, {
				project_id,
				run_id: runId,
				duration_ms: duration,
				counts,
			});
			return failure(c, cause);
		}
	} catch (cause) {
		return failure(c, cause);
	}
}

async function withRunTransaction<T>(
	db: Pick<Pool, "connect">,
	callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		const result = await callback(client);
		await client.query("COMMIT");
		return result;
	} catch (cause) {
		await client.query("ROLLBACK").catch(() => {});
		throw cause;
	} finally {
		client.release();
	}
}

async function activeManagerAndVersion(
	client: Pick<PoolClient, "query">,
	organizationId: string,
	projectId: string,
	actor: string,
): Promise<VersionRow> {
	const authorized = await client.query(
		"SELECT p.id FROM projects p JOIN organization_memberships om ON om.organization_id = p.organization_id AND om.actor_subject = $3 LEFT JOIN LATERAL (SELECT role FROM project_memberships WHERE project_id = p.id AND actor_subject = $3 FOR UPDATE) pm ON true WHERE p.id = $1 AND p.organization_id = $2 AND p.status = 'active' AND (om.role = 'owner' OR pm.role = 'manager') FOR UPDATE OF p, om",
		[projectId, organizationId, actor],
	);
	if (!authorized.rows[0])
		throw new Error(
			"Project is no longer active or manager access was revoked",
		);
	const latest = await client.query<VersionRow>(
		"SELECT v.id, v.version, v.retention, v.redaction, v.content_hash, v.created_by, v.created_at, a.actor_subject AS approved_by, a.approved_at FROM governance_policy_versions v JOIN governance_policies p ON p.id = v.policy_id JOIN governance_policy_approvals a ON a.policy_version_id = v.id WHERE p.project_id = $1 AND p.organization_id = $2 ORDER BY v.version DESC LIMIT 1",
		[projectId, organizationId],
	);
	if (!latest.rows[0]) throw new Error("No approved policy exists");
	return latest.rows[0];
}

async function destructiveStage<T>(
	db: Pick<Pool, "connect">,
	tenant: { organizationId: string; actor: string },
	projectId: string,
	version: VersionRow,
	runId: string,
	stageName: string,
	stage: (client: PoolClient) => Promise<T>,
	counts: Record<string, number>,
): Promise<T> {
	return withRunTransaction(db, async (client) => {
		const current = await activeManagerAndVersion(
			client,
			tenant.organizationId,
			projectId,
			tenant.actor,
		);
		if (current.id !== version.id)
			throw new Error("Policy is stale before destructive stage");
		const result = await stage(client);
		await persistRunProgress(client, runId, counts, stageName);
		return result;
	});
}

async function persistRunProgress(
	client: Pick<PoolClient, "query">,
	runId: string,
	counts: Record<string, number>,
	stage: string,
) {
	await client.query(
		"UPDATE governance_retention_runs SET counts = $2::jsonb, cursor = jsonb_build_object('stage', $3, 'counts', $2::jsonb) WHERE id = $1 AND status = 'running'",
		[runId, JSON.stringify(counts), stage],
	);
}

async function deleteFeedbackRetentionBatch(
	client: Pick<PoolClient, "query">,
	projectId: string,
	cutoff: Date,
	batchSize: number,
) {
	const result = await client.query<{ score_id: string }>(
		"DELETE FROM feedback_reviews WHERE score_id IN (SELECT score_id FROM feedback_reviews WHERE project_id = $1 AND created_at < $2 ORDER BY created_at LIMIT $3) RETURNING score_id",
		[projectId, cutoff, batchSize],
	);
	return result.rows.length;
}
