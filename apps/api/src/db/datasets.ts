import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type JsonObject = Record<string, unknown>;
type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type Row = Record<string, unknown>;

export type DatasetRepositoryErrorCode =
	| "BAD_REQUEST"
	| "NOT_FOUND"
	| "CONFLICT"
	| "INTERNAL";

export class DatasetRepositoryError extends Error {
	readonly status: 400 | 404 | 409 | 500;
	constructor(
		readonly code: DatasetRepositoryErrorCode,
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "DatasetRepositoryError";
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

function normalizeError(value: unknown): DatasetRepositoryError {
	if (value instanceof DatasetRepositoryError) return value;
	const code =
		typeof value === "object" && value !== null && "code" in value
			? value.code
			: undefined;
	if (code === "23505")
		return new DatasetRepositoryError(
			"CONFLICT",
			"Dataset already exists",
			value,
		);
	if (code === "23503")
		return new DatasetRepositoryError(
			"CONFLICT",
			"Dataset item is retained because feedback links it",
			value,
		);
	return new DatasetRepositoryError(
		"INTERNAL",
		"Dataset repository operation failed",
		value,
	);
}

function text(row: Row, key: string): string {
	const value = row[key];
	if (typeof value !== "string")
		throw new DatasetRepositoryError(
			"INTERNAL",
			`Persisted dataset ${key} is invalid`,
		);
	return value;
}
function nullableText(row: Row, key: string): string | null {
	const value = row[key];
	return value === null || value === undefined ? null : text(row, key);
}
function jsonObject(row: Row, key: string): JsonObject {
	const value =
		typeof row[key] === "string" ? JSON.parse(row[key] as string) : row[key];
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new DatasetRepositoryError(
			"INTERNAL",
			`Persisted dataset ${key} is invalid`,
		);
	return value as JsonObject;
}
function timestamp(row: Row, key: string): string {
	const value = row[key];
	return value instanceof Date ? value.toISOString() : text(row, key);
}
function dataset(row: Row) {
	return {
		id: text(row, "id"),
		project_id: text(row, "project_id"),
		name: text(row, "name"),
		description: nullableText(row, "description"),
		item_count: Number(row.item_count),
		created_at: timestamp(row, "created_at"),
		updated_at: timestamp(row, "updated_at"),
	};
}
function item(row: Row) {
	return {
		id: text(row, "id"),
		dataset_id: text(row, "dataset_id"),
		input: jsonObject(row, "input"),
		expected_output:
			row.expected_output == null ? null : jsonObject(row, "expected_output"),
		metadata: jsonObject(row, "metadata"),
		source_trace_id: nullableText(row, "source_trace_id"),
		source_observation_id: nullableText(row, "source_observation_id"),
		created_at: timestamp(row, "created_at"),
	};
}

export async function listDatasets(db: Queryable, project_id: string) {
	try {
		const result = await db.query(
			`SELECT d.*, COUNT(i.id)::int AS item_count FROM datasets d LEFT JOIN dataset_items i ON i.dataset_id = d.id WHERE d.project_id = $1 GROUP BY d.id ORDER BY d.created_at DESC`,
			[project_id],
		);
		return {
			items: result.rows.map(dataset),
			total: result.rowCount ?? result.rows.length,
		};
	} catch (cause) {
		throw normalizeError(cause);
	}
}

export async function createDataset(
	db: Queryable,
	input: { project_id: string; name: string; description?: string | null },
) {
	try {
		const result = await db.query(
			`INSERT INTO datasets (id, project_id, name, description) VALUES ($1, $2, $3, $4) RETURNING *, 0::int AS item_count`,
			[randomUUID(), input.project_id, input.name, input.description ?? null],
		);
		return dataset(result.rows[0]!);
	} catch (cause) {
		throw normalizeError(cause);
	}
}

export async function getDataset(
	db: Queryable,
	input: { project_id: string; id: string },
) {
	try {
		const result = await db.query(
			`SELECT d.*, COUNT(i.id)::int AS item_count FROM datasets d LEFT JOIN dataset_items i ON i.dataset_id = d.id WHERE d.id = $1 AND d.project_id = $2 GROUP BY d.id`,
			[input.id, input.project_id],
		);
		if (!result.rows[0])
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset not found");
		return dataset(result.rows[0]);
	} catch (cause) {
		throw normalizeError(cause);
	}
}

export async function listDatasetItems(
	db: Queryable,
	input: { project_id: string; dataset_id: string },
) {
	try {
		await getDataset(db, {
			project_id: input.project_id,
			id: input.dataset_id,
		});
		const result = await db.query(
			`SELECT i.* FROM dataset_items i JOIN datasets d ON d.id = i.dataset_id WHERE i.dataset_id = $1 AND d.project_id = $2 ORDER BY i.created_at ASC, i.id ASC`,
			[input.dataset_id, input.project_id],
		);
		return { items: result.rows.map(item) };
	} catch (cause) {
		throw normalizeError(cause);
	}
}

export async function addDatasetItem(
	db: Queryable,
	input: {
		project_id: string;
		dataset_id: string;
		input: JsonObject;
		expected_output?: JsonObject | null;
		metadata?: JsonObject;
		source_trace_id?: string | null;
		source_observation_id?: string | null;
	},
) {
	try {
		await getDataset(db, {
			project_id: input.project_id,
			id: input.dataset_id,
		});
		const result = await db.query(
			`INSERT INTO dataset_items (id, dataset_id, input, expected_output, metadata, source_trace_id, source_observation_id) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7) RETURNING *`,
			[
				randomUUID(),
				input.dataset_id,
				JSON.stringify(input.input),
				input.expected_output == null
					? null
					: JSON.stringify(input.expected_output),
				JSON.stringify(input.metadata ?? {}),
				input.source_trace_id ?? null,
				input.source_observation_id ?? null,
			],
		);
		return item(result.rows[0]!);
	} catch (cause) {
		throw normalizeError(cause);
	}
}

export async function deleteDatasetItem(
	db: Queryable,
	input: { project_id: string; dataset_id: string; item_id: string },
) {
	try {
		const result = await db.query(
			`DELETE FROM dataset_items i USING datasets d WHERE i.id = $1 AND i.dataset_id = $2 AND d.id = i.dataset_id AND d.project_id = $3`,
			[input.item_id, input.dataset_id, input.project_id],
		);
		if (result.rowCount !== 1)
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset item not found");
	} catch (cause) {
		throw normalizeError(cause);
	}
}
