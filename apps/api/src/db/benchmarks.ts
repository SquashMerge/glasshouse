import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
	lockActiveAuthorizedProject,
	type ProjectAuthorization,
} from "./project-authorization.js";

type Transactional = Pick<Pool, "connect">;
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
	db: Transactional,
	input: {
		project_id: string;
		dataset_id: string;
		name: string;
		description?: string | null;
		authorization: ProjectAuthorization;
	},
) {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		if (
			!(await lockActiveAuthorizedProject(
				client,
				input.project_id,
				input.authorization,
			))
		)
			throw new BenchmarkRepositoryError(
				"NOT_FOUND",
				"Project is not available",
			);
		const r = await client.query(
			`INSERT INTO benchmark_suites (id, project_id, dataset_id, name, description) SELECT $1,$2,$3,$4,$5 FROM projects WHERE id=$2 AND status='active' RETURNING *`,
			[
				randomUUID(),
				input.project_id,
				input.dataset_id,
				input.name,
				input.description ?? null,
			],
		);
		if (!r.rows[0])
			throw new BenchmarkRepositoryError(
				"NOT_FOUND",
				"Project is not available",
			);
		await client.query("COMMIT");
		return suite(r.rows[0]);
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalize(cause);
	} finally {
		client.release();
	}
}
export async function getBenchmarkSuite(
	db: Transactional,
	input: {
		project_id: string;
		id: string;
		authorization: ProjectAuthorization;
	},
) {
	try {
		const client = await db.connect();
		try {
			await client.query("BEGIN");
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new BenchmarkRepositoryError(
					"NOT_FOUND",
					"Benchmark suite not found",
				);
			const r = await client.query(
				"SELECT b.* FROM benchmark_suites b WHERE b.id=$1 AND b.project_id=$2",
				[input.id, input.project_id],
			);
			if (!r.rows[0])
				throw new BenchmarkRepositoryError(
					"NOT_FOUND",
					"Benchmark suite not found",
				);
			await client.query("COMMIT");
			return suite(r.rows[0]);
		} catch (cause) {
			await client.query("ROLLBACK");
			throw cause;
		} finally {
			client.release();
		}
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listBenchmarkSuites(
	db: Transactional,
	input: { project_id: string; authorization: ProjectAuthorization },
) {
	try {
		const client = await db.connect();
		try {
			await client.query("BEGIN");
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new BenchmarkRepositoryError(
					"NOT_FOUND",
					"Project is not available",
				);
			const r = await client.query(
				"SELECT b.* FROM benchmark_suites b WHERE b.project_id=$1 ORDER BY b.created_at DESC",
				[input.project_id],
			);
			await client.query("COMMIT");
			return { items: r.rows.map(suite), total: r.rowCount ?? r.rows.length };
		} catch (cause) {
			await client.query("ROLLBACK");
			throw cause;
		} finally {
			client.release();
		}
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function createBenchmarkRun(
	db: Transactional,
	input: {
		project_id: string;
		suite_id: string;
		experiment_id: string;
		label: string;
		model?: string | null;
		prompt_version?: string | null;
		authorization: ProjectAuthorization;
	},
) {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		if (
			!(await lockActiveAuthorizedProject(
				client,
				input.project_id,
				input.authorization,
			))
		)
			throw new BenchmarkRepositoryError(
				"NOT_FOUND",
				"Project is not available",
			);
		const r = await client.query(
			`INSERT INTO benchmark_runs (id, project_id, suite_id, experiment_id, label, model, prompt_version) SELECT $1,$2,$3,$4,$5,$6,$7 FROM projects WHERE id=$2 AND status='active' RETURNING *`,
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
		if (!r.rows[0])
			throw new BenchmarkRepositoryError(
				"NOT_FOUND",
				"Project is not available",
			);
		await client.query("COMMIT");
		return run(r.rows[0]);
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalize(cause);
	} finally {
		client.release();
	}
}
export async function listBenchmarkRuns(
	db: Transactional,
	input: {
		project_id: string;
		suite_id: string;
		authorization: ProjectAuthorization;
	},
) {
	try {
		const parent = await getBenchmarkSuite(db, {
			project_id: input.project_id,
			id: input.suite_id,
			authorization: input.authorization,
		});
		const client = await db.connect();
		try {
			await client.query("BEGIN");
			if (
				!(await lockActiveAuthorizedProject(
					client,
					parent.project_id,
					input.authorization,
				))
			)
				throw new BenchmarkRepositoryError(
					"NOT_FOUND",
					"Benchmark suite not found",
				);
			const r = await client.query(
				"SELECT br.*, COUNT(er.id)::int AS total, COUNT(er.id) FILTER (WHERE er.status='completed')::int AS passed, COUNT(er.id) FILTER (WHERE er.status='failed')::int AS failed FROM benchmark_runs br LEFT JOIN experiment_results er ON er.experiment_id=br.experiment_id WHERE br.project_id=$1 AND br.suite_id=$2 GROUP BY br.id ORDER BY CASE WHEN COUNT(er.id)=0 THEN 0 ELSE COUNT(er.id) FILTER (WHERE er.status='completed')::float / COUNT(er.id) END DESC, br.created_at DESC",
				[parent.project_id, input.suite_id],
			);
			await client.query("COMMIT");
			return {
				suite_id: input.suite_id,
				items: r.rows.map((row) => ({
					...run(row),
					total: Number(row.total),
					passed: Number(row.passed),
					failed: Number(row.failed),
					pass_rate:
						Number(row.total) === 0
							? 0
							: Number(row.passed) / Number(row.total),
				})),
			};
		} catch (cause) {
			await client.query("ROLLBACK");
			throw cause;
		} finally {
			client.release();
		}
	} catch (cause) {
		throw normalize(cause);
	}
}
