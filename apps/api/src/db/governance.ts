import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ch } from "./clickhouse.js";
import { lockProjectAuditProvenance } from "./project-authorization.js";

export const RETENTION_CLASSES = ["traces", "datasets", "feedback"] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];
export type GovernanceRedaction = {
	mode: "none" | "all_text";
	keys: string[];
};
export type GovernancePolicyInput = {
	retention: Partial<Record<RetentionClass, number>>;
	redaction: GovernanceRedaction;
};

const keyPattern = /^[a-zA-Z0-9_.-]{1,128}$/;
export function validatePolicy(
	input: GovernancePolicyInput,
): GovernancePolicyInput {
	const retention: Partial<Record<RetentionClass, number>> = {};
	for (const dataClass of Object.keys(input.retention)) {
		if (!RETENTION_CLASSES.includes(dataClass as RetentionClass))
			throw new Error("Unsupported retention data class");
	}

	for (const dataClass of RETENTION_CLASSES) {
		const days = input.retention[dataClass];
		if (days === undefined) continue;
		if (!Number.isInteger(days) || days! < 1 || days! > 3650)
			throw new Error("Retention days must be between 1 and 3650");
		retention[dataClass] = days;
	}
	const keys = [...new Set(input.redaction.keys)].sort();
	if (input.redaction.mode !== "none" && input.redaction.mode !== "all_text")
		throw new Error("Unsupported redaction mode");
	if (keys.some((key) => !keyPattern.test(key)))
		throw new Error("Redaction keys must be simple attribute names");
	return { retention, redaction: { mode: input.redaction.mode, keys } };
}

export function policyHash(input: GovernancePolicyInput): string {
	return createHash("sha256")
		.update(JSON.stringify(validatePolicy(input)))
		.digest("hex");
}

export async function approvedRedaction(
	pool: Pick<Pool, "query">,
	organizationId: string,
	projectId: string,
): Promise<GovernanceRedaction | null> {
	const result = await pool.query<{ redaction: GovernanceRedaction }>(
		"SELECT v.redaction FROM governance_policy_versions v JOIN governance_policies p ON p.id = v.policy_id JOIN governance_policy_approvals a ON a.policy_version_id = v.id WHERE p.organization_id = $1 AND p.project_id = $2 ORDER BY v.version DESC LIMIT 1",
		[organizationId, projectId],
	);
	return result.rows[0]?.redaction ?? null;
}

export async function retentionCounts(
	pool: Pick<Pool, "query">,
	organizationId: string,
	projectId: string,
	retention: Partial<Record<RetentionClass, number>>,
): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const [dataClass, days] of Object.entries(retention)) {
		const cutoff = new Date(Date.now() - days! * 86_400_000);
		if (dataClass === "datasets") {
			const result = await pool.query<{ eligible: string; skipped: string }>(
				"SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM dataset_versions v WHERE v.dataset_id = d.id) AND NOT EXISTS (SELECT 1 FROM experiments e WHERE e.dataset_id = d.id) AND NOT EXISTS (SELECT 1 FROM benchmark_suites b WHERE b.dataset_id = d.id) AND NOT EXISTS (SELECT 1 FROM feedback_reviews f WHERE f.dataset_id = d.id) AND NOT EXISTS (SELECT 1 FROM dataset_retention_holds h WHERE h.project_id = d.project_id AND h.dataset_id = d.id AND h.released_at IS NULL))::text AS eligible, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM dataset_versions v WHERE v.dataset_id = d.id) OR EXISTS (SELECT 1 FROM experiments e WHERE e.dataset_id = d.id) OR EXISTS (SELECT 1 FROM benchmark_suites b WHERE b.dataset_id = d.id) OR EXISTS (SELECT 1 FROM feedback_reviews f WHERE f.dataset_id = d.id) OR EXISTS (SELECT 1 FROM dataset_retention_holds h WHERE h.project_id = d.project_id AND h.dataset_id = d.id AND h.released_at IS NULL))::text AS skipped FROM datasets d WHERE d.project_id = $1 AND d.created_at < $2",
				[projectId, cutoff],
			);
			counts.datasets = Number(result.rows[0]?.eligible ?? 0);
			counts.datasets_skipped = Number(result.rows[0]?.skipped ?? 0);
		}
		if (dataClass === "feedback") {
			const result = await pool.query<{ count: string }>(
				"SELECT count(*)::text AS count FROM feedback_reviews WHERE project_id = $1 AND created_at < $2",
				[projectId, cutoff],
			);
			counts.feedback = Number(result.rows[0]?.count ?? 0);
		}
		if (dataClass === "traces") {
			const result = await ch().query({
				query:
					"WITH grouped AS (SELECT trace_id, max(start_time) AS newest, count() AS physical_rows FROM (SELECT trace_id, start_time FROM traces WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} UNION ALL SELECT trace_id, start_time FROM observations WHERE organization_id = {organizationId:String} AND project_id = {projectId:String}) GROUP BY trace_id) SELECT countIf(newest < {cutoff:DateTime64(3)} AND physical_rows <= 500) AS count, countIf(newest < {cutoff:DateTime64(3)} AND physical_rows > 500) AS skipped FROM grouped",
				query_params: {
					organizationId,
					projectId,
					cutoff: cutoff.toISOString(),
				},
				format: "JSONEachRow",
			});
			const rows = await result.json<{ count: string; skipped: string }>();
			counts.traces = Number(rows[0]?.count ?? 0);
			counts.traces_skipped = Number(rows[0]?.skipped ?? 0);
		}
	}
	return counts;
}

export async function deleteSafeDatasetRetentionBatch(
	client: Pick<PoolClient, "query">,
	projectId: string,
	cutoff: Date,
	batchSize: number,
	runId: string,
	ownerToken: string,
): Promise<{ deleted: number; skipped: number }> {
	await lockProjectAuditProvenance(client, projectId);
	await client.query(
		"SELECT set_config('astraea.dataset_retention_run_id', $1, true), set_config('astraea.dataset_retention_owner_token', $2, true)",
		[runId, ownerToken],
	);
	const result = await client.query<{ id: string | null; skipped: string }>(
		"WITH candidates AS MATERIALIZED (SELECT d.id, d.slug FROM datasets d WHERE d.project_id = $1 AND d.created_at < $2 AND NOT EXISTS (SELECT 1 FROM dataset_versions v WHERE v.dataset_id = d.id) AND NOT EXISTS (SELECT 1 FROM experiments e WHERE e.dataset_id = d.id) AND NOT EXISTS (SELECT 1 FROM benchmark_suites b WHERE b.dataset_id = d.id) AND NOT EXISTS (SELECT 1 FROM feedback_reviews f WHERE f.dataset_id = d.id) AND NOT EXISTS (SELECT 1 FROM dataset_retention_holds h WHERE h.project_id = d.project_id AND h.dataset_id = d.id AND h.released_at IS NULL) ORDER BY d.created_at, d.id LIMIT $3 FOR UPDATE), ordered_candidates AS MATERIALIZED (SELECT id, slug FROM candidates ORDER BY slug), locked_slugs AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtext(format('dataset:%s:%s', $1, slug))) FROM ordered_candidates), inserted_tombstones AS (INSERT INTO dataset_tombstones (project_id, slug) SELECT $1, c.slug FROM candidates c CROSS JOIN (SELECT count(*) FROM locked_slugs) locks ON CONFLICT (project_id, slug) DO NOTHING RETURNING slug), reserved AS (SELECT slug FROM inserted_tombstones UNION SELECT c.slug FROM candidates c JOIN dataset_tombstones t ON t.project_id = $1 AND t.slug = c.slug), deleted_quarantined_items AS (DELETE FROM dataset_item_input_quarantine q USING candidates c WHERE q.project_id = $1 AND q.dataset_id = c.id RETURNING q.id), deleted_released_holds AS (DELETE FROM dataset_retention_holds h USING candidates c WHERE h.project_id = $1 AND h.dataset_id = c.id AND h.released_at IS NOT NULL RETURNING h.id), deleted AS (DELETE FROM datasets d USING candidates c JOIN reserved r ON r.slug = c.slug WHERE d.id = c.id AND (SELECT count(*) FROM deleted_quarantined_items) >= 0 AND (SELECT count(*) FROM deleted_released_holds) >= 0 RETURNING d.id), skipped AS (SELECT count(*)::text AS count FROM datasets d WHERE d.project_id = $1 AND d.created_at < $2 AND (EXISTS (SELECT 1 FROM dataset_versions v WHERE v.dataset_id = d.id) OR EXISTS (SELECT 1 FROM experiments e WHERE e.dataset_id = d.id) OR EXISTS (SELECT 1 FROM benchmark_suites b WHERE b.dataset_id = d.id) OR EXISTS (SELECT 1 FROM feedback_reviews f WHERE f.dataset_id = d.id) OR EXISTS (SELECT 1 FROM dataset_retention_holds h WHERE h.project_id = d.project_id AND h.dataset_id = d.id AND h.released_at IS NULL))) SELECT id, (SELECT count FROM skipped) AS skipped FROM deleted UNION ALL SELECT NULL::uuid AS id, count AS skipped FROM skipped WHERE NOT EXISTS (SELECT 1 FROM deleted)",
		[projectId, cutoff, batchSize],
	);
	return {
		deleted: result.rows.filter((row) => row.id !== null).length,
		skipped: Number(result.rows[0]?.skipped ?? 0),
	};
}

export type TraceRetentionSelection = {
	traceIds: string[];
	physicalUnits: number;
};

export async function selectTraceRetentionBatch(
	organizationId: string,
	projectId: string,
	cutoff: Date,
	batchSize: number,
): Promise<TraceRetentionSelection> {
	const client = ch();
	const selected = await client.query({
		query:
			"WITH grouped AS (SELECT trace_id, min(start_time) AS oldest, max(start_time) AS newest, count() AS physical_rows FROM (SELECT trace_id, start_time FROM traces WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} UNION ALL SELECT trace_id, start_time FROM observations WHERE organization_id = {organizationId:String} AND project_id = {projectId:String}) GROUP BY trace_id HAVING newest < {cutoff:DateTime64(3)} AND physical_rows <= {batchSize:UInt64}), bounded AS (SELECT trace_id, physical_rows, oldest, sum(physical_rows) OVER (ORDER BY oldest, trace_id) AS cumulative_rows FROM grouped) SELECT trace_id, physical_rows FROM bounded WHERE cumulative_rows <= {batchSize:UInt64} ORDER BY oldest, trace_id",
		query_params: {
			organizationId,
			projectId,
			cutoff: cutoff.toISOString(),
			batchSize,
		},
		format: "JSONEachRow",
	});
	const rows = await selected.json<{
		trace_id: string;
		physical_rows: string;
	}>();
	return {
		traceIds: rows.map((row) => row.trace_id),
		physicalUnits: rows.reduce(
			(total, row) => total + Number(row.physical_rows),
			0,
		),
	};
}

export async function deleteTraceObservations(
	organizationId: string,
	projectId: string,
	cutoff: Date,
	traceIds: string[],
): Promise<void> {
	if (!traceIds.length) return;
	const client = ch();
	const query_params = {
		organizationId,
		projectId,
		traceIds,
		cutoff: cutoff.toISOString(),
	};
	await client.command({
		query:
			"ALTER TABLE observations DELETE WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} AND trace_id IN {traceIds:Array(String)} AND start_time < {cutoff:DateTime64(3)} SETTINGS mutations_sync = 1",
		query_params,
	});
}

export async function deleteTraces(
	organizationId: string,
	projectId: string,
	cutoff: Date,
	traceIds: string[],
): Promise<void> {
	if (!traceIds.length) return;
	const client = ch();
	const query_params = {
		organizationId,
		projectId,
		traceIds,
		cutoff: cutoff.toISOString(),
	};
	await client.command({
		query:
			"ALTER TABLE traces DELETE WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} AND trace_id IN {traceIds:Array(String)} AND start_time < {cutoff:DateTime64(3)} SETTINGS mutations_sync = 1",
		query_params,
	});
}

export async function failInterruptedRetentionRuns(
	pool: Pick<Pool, "connect">,
): Promise<Array<{ id: string; project_id: string }>> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const expired = await client.query<{ id: string; project_id: string }>(
			"SELECT r.id, r.project_id FROM governance_retention_runs r JOIN projects p ON p.id = r.project_id WHERE r.status = 'running' AND r.lease_expires_at < now() ORDER BY r.project_id, r.id FOR UPDATE OF p, r",
		);
		if (!expired.rows.length) {
			await client.query("COMMIT");
			return [];
		}
		for (const projectId of [
			...new Set(expired.rows.map((run) => run.project_id)),
		].sort())
			await lockProjectAuditProvenance(client, projectId);
		const failed = await client.query<{ id: string; project_id: string }>(
			"WITH expired AS MATERIALIZED (SELECT r.id, r.organization_id, r.project_id, r.policy_version_id, r.requested_by, r.counts, r.started_at FROM governance_retention_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ANY($1::uuid[]) AND r.status = 'running' AND r.lease_expires_at < now() FOR UPDATE OF p, r), failed AS (UPDATE governance_retention_runs r SET status = 'failed', completed_at = now(), lease_expires_at = NULL FROM expired e WHERE r.id = e.id AND r.status = 'running' AND r.lease_expires_at < now() RETURNING r.id, r.organization_id, r.project_id, r.policy_version_id, r.requested_by, r.counts, r.started_at), audit AS (INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type, counts, duration_ms) SELECT organization_id, project_id, policy_version_id, requested_by, 'retention_failed', counts, GREATEST(0, round(EXTRACT(epoch FROM now() - started_at) * 1000)::integer) FROM failed) SELECT id, project_id FROM failed",
			[expired.rows.map((run) => run.id)],
		);
		await client.query("COMMIT");
		return failed.rows;
	} catch (cause) {
		await client.query("ROLLBACK").catch(() => {});
		throw cause;
	} finally {
		client.release();
	}
}
