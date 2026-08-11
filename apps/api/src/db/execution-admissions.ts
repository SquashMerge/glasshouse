import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type ExecutionAdmission = {
	id: string;
	project_id: string;
	requester_actor_id: string;
	authorization_epoch: number;
};

export type ExecutionAdmissionEffect =
	| "provider_dispatch"
	| "trace_write"
	| "metric_write"
	| "result_write"
	| "event_write";

export type ExecutionAdmissionClaim = {
	status: "created" | "existing" | "unavailable";
};

type Transactional = Pick<Pool, "connect">;

async function transaction<T>(
	pool: Transactional,
	callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
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

export async function createExecutionAdmission(
	client: Pick<PoolClient, "query">,
	input: {
		organization_id: string;
		project_id: string;
		requester_actor_id: string;
		work_kind: "optimization" | "experiment_task";
		work_id: string;
		timeout_ms: number;
	},
): Promise<ExecutionAdmission | null> {
	const epoch = await client.query<{ authorization_epoch: string | number }>(
		"SELECT authorization_epoch FROM projects WHERE id = $1 AND organization_id = $2 AND status = 'active' FOR UPDATE",
		[input.project_id, input.organization_id],
	);
	const authorizationEpoch = Number(epoch.rows[0]?.authorization_epoch);
	if (!Number.isSafeInteger(authorizationEpoch) || authorizationEpoch < 1)
		return null;
	const admission = await client.query<ExecutionAdmission>(
		"INSERT INTO execution_admissions (id, organization_id, project_id, requester_actor_id, work_kind, work_id, authorization_epoch, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::integer * interval '1 millisecond')) RETURNING id, project_id, requester_actor_id, authorization_epoch",
		[
			randomUUID(),
			input.organization_id,
			input.project_id,
			input.requester_actor_id,
			input.work_kind,
			input.work_id,
			authorizationEpoch,
			input.timeout_ms,
		],
	);
	return admission.rows[0] ?? null;
}

export async function executionAdmissionIsActive(
	client: Pick<PoolClient, "query">,
	input: { id: string; project_id: string },
): Promise<boolean> {
	const active = await client.query(
		"SELECT admission.id FROM execution_admissions AS admission JOIN projects AS project ON project.id = admission.project_id AND project.organization_id = admission.organization_id WHERE admission.id = $1 AND admission.project_id = $2 AND admission.status = 'active' AND admission.expires_at > now() AND project.status = 'active' AND project.authorization_epoch = admission.authorization_epoch FOR UPDATE OF admission",
		[input.id, input.project_id],
	);
	return Boolean(active.rows[0]);
}

/**
 * Call only after the caller has locked the requester memberships then Project
 * fence. An effect key identifies the one replay-safe logical effect.
 */
export async function claimExecutionAdmission(
	client: Pick<PoolClient, "query">,
	input: {
		id: string;
		project_id: string;
		effect: ExecutionAdmissionEffect;
		effect_key: string;
	},
): Promise<ExecutionAdmissionClaim> {
	const claim = await client.query(
		"WITH active_admission AS (SELECT admission.id, admission.authorization_epoch, admission.expires_at FROM execution_admissions AS admission JOIN projects AS project ON project.id = admission.project_id AND project.organization_id = admission.organization_id WHERE admission.id = $1 AND admission.project_id = $2 AND admission.status = 'active' AND admission.expires_at > now() AND project.status = 'active' AND project.authorization_epoch = admission.authorization_epoch FOR UPDATE OF admission, project) INSERT INTO execution_admission_claims (id, admission_id, effect, effect_key, authorization_epoch, expires_at) SELECT gen_random_uuid(), id, $3, $4, authorization_epoch, expires_at FROM active_admission ON CONFLICT (admission_id, effect, effect_key) DO NOTHING RETURNING id",
		[input.id, input.project_id, input.effect, input.effect_key],
	);
	if (claim.rows[0]) return { status: "created" };
	const existing = await client.query(
		"SELECT id FROM execution_admission_claims WHERE admission_id = $1 AND effect = $2 AND effect_key = $3",
		[input.id, input.effect, input.effect_key],
	);
	return { status: existing.rows[0] ? "existing" : "unavailable" };
}

export async function cancelExecutionAdmission(
	pool: Transactional,
	id: string,
): Promise<void> {
	await transaction(pool, async (client) => {
		const admission = await client.query<{ project_id: string }>(
			"SELECT project_id FROM execution_admissions WHERE id = $1 FOR UPDATE",
			[id],
		);
		if (!admission.rows[0]) return;
		await client.query(
			"UPDATE execution_admissions SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'active'",
			[id],
		);
	});
}

export async function completeExecutionAdmission(
	pool: Transactional,
	id: string,
): Promise<void> {
	await transaction(pool, async (client) => {
		await client.query(
			"UPDATE execution_admissions SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'active'",
			[id],
		);
	});
}

export async function cancelInterruptedExecutionAdmissions(
	pool: Pick<Pool, "query">,
): Promise<number> {
	const cancelled = await pool.query(
		"UPDATE execution_admissions SET status = 'cancelled', cancelled_at = now() WHERE status = 'active' RETURNING id",
	);
	return cancelled.rowCount ?? cancelled.rows.length;
}
