import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { ch } from "./clickhouse.js";

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
			const result = await pool.query<{ count: string }>(
				"SELECT count(*)::text AS count FROM datasets WHERE project_id = $1 AND created_at < $2",
				[projectId, cutoff],
			);
			counts.datasets = Number(result.rows[0]?.count ?? 0);
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
					"SELECT count() AS count FROM traces WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} AND start_time < {cutoff:DateTime64(3)}",
				query_params: {
					organizationId,
					projectId,
					cutoff: cutoff.toISOString(),
				},
				format: "JSONEachRow",
			});
			const rows = await result.json<{ count: string }>();
			counts.traces = Number(rows[0]?.count ?? 0);
		}
	}
	return counts;
}
