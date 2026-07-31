import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type Row = Record<string, unknown>;
export type ExperimentStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";
export type JsonObject = Record<string, unknown>;
export type ExperimentTaskStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";
export type ClaimedExperimentTask = {
	id: string;
	dataset_item_id: string;
	lease_token: string;
	input: JsonObject;
	expected_output: unknown;
};
export type RecoverableExperiment = {
	id: string;
	project_id: string;
	dataset_id: string;
	config: JsonObject;
};

export class ExperimentRepositoryError extends Error {
	readonly status: 400 | 404 | 409 | 500;
	constructor(
		readonly code: "NOT_FOUND" | "CONFLICT" | "INTERNAL",
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "ExperimentRepositoryError";
		this.status = code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 500;
	}
}

function normalize(value: unknown): ExperimentRepositoryError {
	if (value instanceof ExperimentRepositoryError) return value;
	if (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		value.code === "23505"
	)
		return new ExperimentRepositoryError(
			"CONFLICT",
			"Experiment already exists",
			value,
		);
	return new ExperimentRepositoryError(
		"INTERNAL",
		"Experiment repository operation failed",
		value,
	);
}
function text(row: Row, key: string): string {
	if (typeof row[key] !== "string")
		throw new ExperimentRepositoryError("INTERNAL", `Invalid ${key}`);
	return row[key] as string;
}
function nullableText(row: Row, key: string): string | null {
	return row[key] == null ? null : text(row, key);
}
function json(row: Row, key: string): JsonObject {
	const value =
		typeof row[key] === "string" ? JSON.parse(row[key] as string) : row[key];
	return (
		value && typeof value === "object" && !Array.isArray(value) ? value : {}
	) as JsonObject;
}
function time(row: Row, key: string): string {
	return row[key] instanceof Date
		? (row[key] as Date).toISOString()
		: text(row, key);
}
function experiment(row: Row) {
	return {
		id: text(row, "id"),
		project_id: text(row, "project_id"),
		agent_id: nullableText(row, "agent_id"),
		dataset_id: text(row, "dataset_id"),
		name: nullableText(row, "name"),
		status: text(row, "status") as ExperimentStatus,
		config: json(row, "config"),
		created_at: time(row, "created_at"),
		updated_at: time(row, "updated_at"),
	};
}
function result(row: Row) {
	return {
		id: text(row, "id"),
		experiment_id: text(row, "experiment_id"),
		dataset_item_id: text(row, "dataset_item_id"),
		agent_version: nullableText(row, "agent_version"),
		output: row.output == null ? null : json(row, "output"),
		scores: json(row, "scores") as Record<string, number>,
		duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
		status: text(row, "status") as ExperimentStatus,
		created_at: time(row, "created_at"),
	};
}

export async function createExperiment(
	db: Pick<Pool, "connect">,
	input: {
		project_id: string;
		dataset_id: string;
		name?: string | null;
		config: JsonObject;
		agent_id?: string | null;
	},
) {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		const active = await client.query(
			"SELECT id FROM projects WHERE id = $1 AND status = 'active' FOR UPDATE",
			[input.project_id],
		);
		if (!active.rows[0])
			throw new ExperimentRepositoryError(
				"NOT_FOUND",
				"Project is not available",
			);
		const r = await client.query(
			`INSERT INTO experiments (id, project_id, agent_id, dataset_id, name, config, status) SELECT $1,$2,$3,$4,$5,$6::jsonb,'pending' WHERE $3 IS NULL OR EXISTS (SELECT 1 FROM agents WHERE id=$3 AND project_id=$2) RETURNING *`,
			[
				randomUUID(),
				input.project_id,
				input.agent_id ?? null,
				input.dataset_id,
				input.name ?? null,
				JSON.stringify(input.config),
			],
		);
		if (!r.rows[0])
			throw new ExperimentRepositoryError("NOT_FOUND", "Agent not found");
		await client.query("COMMIT");
		return experiment(r.rows[0]);
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalize(cause);
	} finally {
		client.release();
	}
}
export async function listExperiments(db: Queryable, project_id: string) {
	try {
		const r = await db.query(
			`SELECT * FROM experiments WHERE project_id=$1 ORDER BY created_at DESC`,
			[project_id],
		);
		return {
			items: r.rows.map(experiment),
			total: r.rowCount ?? r.rows.length,
		};
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function getExperiment(
	db: Queryable,
	input: { project_id: string; id: string },
) {
	try {
		const r = await db.query(
			`SELECT * FROM experiments WHERE id=$1 AND project_id=$2`,
			[input.id, input.project_id],
		);
		if (!r.rows[0])
			throw new ExperimentRepositoryError("NOT_FOUND", "Experiment not found");
		return experiment(r.rows[0]);
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function updateExperiment(
	db: Queryable,
	input: {
		project_id: string;
		id: string;
		status: ExperimentStatus;
		/** Apply only when the persisted state is one of these values. */
		if_status?: ExperimentStatus | ExperimentStatus[];
	},
) {
	try {
		const expected = input.if_status
			? Array.isArray(input.if_status)
				? input.if_status
				: [input.if_status]
			: null;
		const r = await db.query(
			`UPDATE experiments e SET status=$1, updated_at=now() FROM projects p WHERE e.id=$2 AND e.project_id=$3 AND p.id=e.project_id AND p.status = 'active'${expected ? " AND e.status = ANY($4::text[])" : ""} RETURNING e.*`,
			expected
				? [input.status, input.id, input.project_id, expected]
				: [input.status, input.id, input.project_id],
		);
		if (r.rows[0]) return experiment(r.rows[0]);
		// A conditional transition that lost a race returns the persisted state. This
		// keeps cancellation terminal rather than turning a concurrent cancel into a
		// spurious NOT_FOUND or resurrecting the evaluation.
		if (expected) return getExperiment(db, input);
		throw new ExperimentRepositoryError("NOT_FOUND", "Experiment not found");
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listRecoverableExperiments(db: Queryable) {
	try {
		const result = await db.query(
			"SELECT e.id, e.project_id, e.dataset_id, e.config FROM experiments e JOIN projects p ON p.id=e.project_id WHERE e.status IN ('pending', 'running') AND p.status = 'active' ORDER BY e.created_at ASC",
		);
		return result.rows.map((row) => ({
			id: text(row, "id"),
			project_id: text(row, "project_id"),
			dataset_id: text(row, "dataset_id"),
			config: json(row, "config"),
		}));
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function claimExperimentTask(
	db: Queryable,
	input: {
		project_id: string;
		experiment_id: string;
		lease_seconds?: number;
		lease_token?: string;
	},
): Promise<ClaimedExperimentTask | null> {
	try {
		const lease_token = input.lease_token ?? randomUUID();
		const r = await db.query(
			`WITH candidate AS (
				SELECT t.id
				FROM experiment_tasks t
				JOIN experiments e ON e.id = t.experiment_id
				JOIN projects p ON p.id = e.project_id
				WHERE t.experiment_id = $1
					AND e.project_id = $2
					AND e.status = 'running'
					AND p.status = 'active'
					AND (t.status = 'pending' OR (t.status = 'running' AND t.lease_expires_at <= now()))
				ORDER BY t.created_at ASC
				FOR UPDATE OF t SKIP LOCKED
				LIMIT 1
			), claimed AS (
				UPDATE experiment_tasks t
				SET status = 'running', lease_token = $3::uuid,
					lease_expires_at = now() + ($4::integer * interval '1 second'),
					claimed_at = coalesce(t.claimed_at, now()), attempt_count = t.attempt_count + 1,
					updated_at = now()
				FROM candidate c WHERE t.id = c.id
				RETURNING t.id, t.dataset_item_id, t.lease_token
			)
			SELECT c.id AS task_id, c.dataset_item_id, c.lease_token, i.input, i.expected_output
			FROM claimed c JOIN dataset_items i ON i.id = c.dataset_item_id`,
			[
				input.experiment_id,
				input.project_id,
				lease_token,
				input.lease_seconds ?? 60,
			],
		);
		const row = r.rows[0];
		return row
			? {
					id: text(row, "task_id"),
					dataset_item_id: text(row, "dataset_item_id"),
					lease_token: text(row, "lease_token"),
					input: json(row, "input"),
					expected_output: row.expected_output,
				}
			: null;
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function nextExperimentTaskRetryDelay(
	db: Queryable,
	input: { project_id: string; experiment_id: string },
): Promise<number | null> {
	try {
		const r = await db.query(
			`SELECT ceil(extract(epoch FROM min(t.lease_expires_at) - now()) * 1000)::int AS delay_ms
			FROM experiment_tasks t JOIN experiments e ON e.id = t.experiment_id JOIN projects p ON p.id=e.project_id
			WHERE t.experiment_id = $1 AND e.project_id = $2 AND e.status = 'running' AND p.status = 'active'
				AND t.status = 'running' AND t.lease_expires_at > now()`,
			[input.experiment_id, input.project_id],
		);
		const delay = r.rows[0]?.delay_ms;
		return typeof delay === "number" ? Math.max(0, delay) : null;
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function finalizeExperimentTask(
	db: Queryable,
	input: {
		project_id: string;
		experiment_id: string;
		task_id: string;
		lease_token: string;
		status: Extract<ExperimentTaskStatus, "completed" | "failed">;
		agent_version?: string | null;
		output?: JsonObject | null;
		scores: Record<string, number>;
		duration_ms?: number | null;
	},
): Promise<boolean> {
	try {
		const r = await db.query(
			`WITH finalized_task AS (
				UPDATE experiment_tasks t
				SET status = $5, lease_token = NULL, lease_expires_at = NULL,
					completed_at = now(), updated_at = now()
			FROM experiments e
			JOIN projects p ON p.id = e.project_id
				WHERE t.id = $1 AND t.experiment_id = $2 AND e.id = t.experiment_id
					AND e.project_id = $3 AND t.lease_token = $4::uuid
					AND t.status = 'running' AND e.status = 'running' AND p.status = 'active'
				RETURNING t.experiment_id, t.dataset_item_id
			), inserted_result AS (
				INSERT INTO experiment_results (id, experiment_id, dataset_item_id, agent_version, output, scores, duration_ms, status)
				SELECT gen_random_uuid(), experiment_id, dataset_item_id, $6, $7::jsonb, $8::jsonb, $9, $5
				FROM finalized_task
				ON CONFLICT (experiment_id, dataset_item_id) DO NOTHING
				RETURNING id
			)
			SELECT EXISTS (SELECT 1 FROM finalized_task) AS finalized`,
			[
				input.task_id,
				input.experiment_id,
				input.project_id,
				input.lease_token,
				input.status,
				input.agent_version ?? null,
				input.output == null ? null : JSON.stringify(input.output),
				JSON.stringify(input.scores),
				input.duration_ms ?? null,
			],
		);
		return r.rows[0]?.finalized === true;
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function completeExperimentIfTasksFinished(
	db: Queryable,
	input: { project_id: string; id: string },
): Promise<boolean> {
	try {
		const r = await db.query(
			`UPDATE experiments e SET status='completed', updated_at=now()
			FROM projects p WHERE e.id=$1 AND e.project_id=$2 AND p.id=e.project_id AND p.status = 'active' AND e.status='running'
				AND NOT EXISTS (
					SELECT 1 FROM experiment_tasks t
					WHERE t.experiment_id=e.id AND t.status IN ('pending', 'running')
				)
			RETURNING e.id`,
			[input.id, input.project_id],
		);
		return Boolean(r.rows[0]);
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function cancelExperiment(
	db: Queryable,
	input: { project_id: string; id: string },
) {
	try {
		const r = await db.query(
			`WITH cancelled AS (
				UPDATE experiments SET status='cancelled', updated_at=now()
				WHERE id=$1 AND project_id=$2 AND status IN ('pending','running')
				RETURNING *
			), cancelled_tasks AS (
				UPDATE experiment_tasks t SET status='cancelled', lease_token=NULL,
					lease_expires_at=NULL, updated_at=now()
				FROM cancelled e
				WHERE t.experiment_id=e.id AND t.status IN ('pending','running')
				RETURNING t.id
			)
			SELECT * FROM cancelled`,
			[input.id, input.project_id],
		);
		if (!r.rows[0]) {
			const existing = await getExperiment(db, input);
			throw new ExperimentRepositoryError(
				"CONFLICT",
				`Evaluation is already ${existing.status}`,
			);
		}
		return experiment(r.rows[0]);
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function insertExperimentResult(
	db: Queryable,
	input: {
		experiment_id: string;
		dataset_item_id: string;
		agent_version?: string | null;
		output?: JsonObject | null;
		scores: Record<string, number>;
		duration_ms?: number | null;
		status: ExperimentStatus;
	},
) {
	try {
		const r = await db.query(
			`INSERT INTO experiment_results (id, experiment_id, dataset_item_id, agent_version, output, scores, duration_ms, status) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING *`,
			[
				randomUUID(),
				input.experiment_id,
				input.dataset_item_id,
				input.agent_version ?? null,
				input.output == null ? null : JSON.stringify(input.output),
				JSON.stringify(input.scores),
				input.duration_ms ?? null,
				input.status,
			],
		);
		return result(r.rows[0]!);
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listExperimentResults(
	db: Queryable,
	input: { project_id: string; id: string },
) {
	try {
		await getExperiment(db, input);
		const r = await db.query(
			`SELECT r.* FROM experiment_results r JOIN experiments e ON e.id=r.experiment_id WHERE r.experiment_id=$1 AND e.project_id=$2 ORDER BY r.created_at ASC`,
			[input.id, input.project_id],
		);
		return { experiment_id: input.id, items: r.rows.map(result) };
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function experimentSummary(
	db: Queryable,
	input: { project_id: string; id: string },
) {
	try {
		await getExperiment(db, input);
		const r = await db.query(
			`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='completed')::int AS passed, COUNT(*) FILTER (WHERE status='failed')::int AS failed, AVG(duration_ms)::float AS avg_duration_ms FROM experiment_results WHERE experiment_id=$1`,
			[input.id],
		);
		const row = r.rows[0] ?? {};
		const total = Number(row.total ?? 0);
		return {
			experiment_id: input.id,
			total,
			passed: Number(row.passed ?? 0),
			failed: Number(row.failed ?? 0),
			pass_rate: total === 0 ? 0 : Number(row.passed ?? 0) / total,
			avg_duration_ms:
				row.avg_duration_ms == null ? null : Number(row.avg_duration_ms),
		};
	} catch (cause) {
		throw normalize(cause);
	}
}
