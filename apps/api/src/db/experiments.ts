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
	db: Queryable,
	input: {
		project_id: string;
		dataset_id: string;
		name?: string | null;
		config: JsonObject;
		agent_id?: string | null;
	},
) {
	try {
		const r = await db.query(
			`INSERT INTO experiments (id, project_id, agent_id, dataset_id, name, config, status) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending') RETURNING *`,
			[
				randomUUID(),
				input.project_id,
				input.agent_id ?? null,
				input.dataset_id,
				input.name ?? null,
				JSON.stringify(input.config),
			],
		);
		return experiment(r.rows[0]!);
	} catch (cause) {
		throw normalize(cause);
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
			`UPDATE experiments SET status=$1, updated_at=now() WHERE id=$2 AND project_id=$3${expected ? " AND status = ANY($4::text[])" : ""} RETURNING *`,
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
export async function failInterruptedExperiments(db: Queryable) {
	try {
		const result = await db.query(
			"UPDATE experiments SET status='failed', updated_at=now() WHERE status IN ('pending','running') RETURNING id, project_id",
		);
		return result.rows.map((row) => ({
			id: text(row, "id"),
			project_id: text(row, "project_id"),
		}));
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
			`UPDATE experiments SET status='cancelled', updated_at=now() WHERE id=$1 AND project_id=$2 AND status IN ('pending','running') RETURNING *`,
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
