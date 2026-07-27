import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type Row = Record<string, any>;

export class BenchmarkRepositoryError extends Error {
	readonly status: 400 | 404 | 409 | 500;
	constructor(
		readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "INTERNAL",
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.status =
			code === "BAD_REQUEST"
				? 400
				: code === "NOT_FOUND"
					? 404
					: code === "CONFLICT"
						? 409
						: 500;
	}
}
function normalize(value: any): BenchmarkRepositoryError {
	if (value instanceof BenchmarkRepositoryError) return value;
	if (value?.code === "23505")
		return new BenchmarkRepositoryError(
			"CONFLICT",
			"Benchmark already exists",
			value,
		);
	if (value?.code === "23503")
		return new BenchmarkRepositoryError(
			"NOT_FOUND",
			"Referenced resource not found",
			value,
		);
	return new BenchmarkRepositoryError(
		"INTERNAL",
		"Benchmark repository operation failed",
		value,
	);
}
function text(row: Row, key: string): string {
	if (typeof row[key] !== "string")
		throw new BenchmarkRepositoryError("INTERNAL", `Invalid ${key}`);
	return row[key];
}
function nullableText(row: Row, key: string): string | null {
	return row[key] == null ? null : text(row, key);
}
function time(row: Row, key: string): string {
	return row[key] instanceof Date ? row[key].toISOString() : text(row, key);
}
function suite(row: Row) {
	return {
		id: text(row, "id"),
		project_id: text(row, "project_id"),
		dataset_id: text(row, "dataset_id"),
		name: text(row, "name"),
		description: nullableText(row, "description"),
		created_at: time(row, "created_at"),
		updated_at: time(row, "updated_at"),
	};
}
function run(row: Row) {
	return {
		id: text(row, "id"),
		project_id: text(row, "project_id"),
		suite_id: text(row, "suite_id"),
		experiment_id: text(row, "experiment_id"),
		label: text(row, "label"),
		model: nullableText(row, "model"),
		prompt_version: nullableText(row, "prompt_version"),
		created_at: time(row, "created_at"),
	};
}
export async function createBenchmarkSuite(
	db: Queryable,
	input: {
		project_id: string;
		dataset_id: string;
		name: string;
		description?: string | null;
	},
) {
	try {
		const r = await db.query(
			`INSERT INTO benchmark_suites (id, project_id, dataset_id, name, description) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
			[
				randomUUID(),
				input.project_id,
				input.dataset_id,
				input.name,
				input.description ?? null,
			],
		);
		return suite(r.rows[0]);
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function getBenchmarkSuite(
	db: Queryable,
	input: { project_id: string; id: string },
) {
	try {
		const r = await db.query(
			`SELECT * FROM benchmark_suites WHERE id=$1 AND project_id=$2`,
			[input.id, input.project_id],
		);
		if (!r.rows[0])
			throw new BenchmarkRepositoryError(
				"NOT_FOUND",
				"Benchmark suite not found",
			);
		return suite(r.rows[0]);
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listBenchmarkSuites(db: Queryable, project_id: string) {
	try {
		const r = await db.query(
			`SELECT * FROM benchmark_suites WHERE project_id=$1 ORDER BY created_at DESC`,
			[project_id],
		);
		return { items: r.rows.map(suite), total: r.rowCount ?? r.rows.length };
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function createBenchmarkRun(
	db: Queryable,
	input: {
		project_id: string;
		suite_id: string;
		experiment_id: string;
		label: string;
		model?: string | null;
		prompt_version?: string | null;
	},
) {
	try {
		const r = await db.query(
			`INSERT INTO benchmark_runs (id, project_id, suite_id, experiment_id, label, model, prompt_version) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
			[
				randomUUID(),
				input.project_id,
				input.suite_id,
				input.experiment_id,
				input.label,
				input.model ?? null,
				input.prompt_version ?? null,
			],
		);
		return run(r.rows[0]);
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listBenchmarkRuns(
	db: Queryable,
	input: { project_id: string; suite_id: string },
) {
	try {
		await getBenchmarkSuite(db, {
			project_id: input.project_id,
			id: input.suite_id,
		});
		const r = await db.query(
			`SELECT br.*, COUNT(er.id)::int AS total, COUNT(er.id) FILTER (WHERE er.status='completed')::int AS passed, COUNT(er.id) FILTER (WHERE er.status='failed')::int AS failed FROM benchmark_runs br LEFT JOIN experiment_results er ON er.experiment_id=br.experiment_id WHERE br.project_id=$1 AND br.suite_id=$2 GROUP BY br.id ORDER BY CASE WHEN COUNT(er.id)=0 THEN 0 ELSE COUNT(er.id) FILTER (WHERE er.status='completed')::float / COUNT(er.id) END DESC, br.created_at DESC`,
			[input.project_id, input.suite_id],
		);
		return {
			suite_id: input.suite_id,
			items: r.rows.map((row) => ({
				...run(row),
				total: Number(row.total),
				passed: Number(row.passed),
				failed: Number(row.failed),
				pass_rate:
					Number(row.total) === 0 ? 0 : Number(row.passed) / Number(row.total),
			})),
		};
	} catch (cause) {
		throw normalize(cause);
	}
}
