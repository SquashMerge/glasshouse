import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	lockActiveAuthorizedProject,
	lockProjectAuditProvenance,
	type ProjectAuthorization,
} from "./project-authorization.js";

export type JsonObject = Record<string, unknown>;
type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type Transactional = Pick<Pool, "connect">;
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

export async function authorizeDatasetWrite(
	db: Transactional,
	input: { project_id: string; authorization: ProjectAuthorization },
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		await client.query("COMMIT");
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
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
		slug: text(row, "slug"),
		name: text(row, "name"),
		description: nullableText(row, "description"),
		tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
		latest_published_version:
			row.latest_published_version == null
				? null
				: Number(row.latest_published_version),
		archived_at: row.archived_at == null ? null : timestamp(row, "archived_at"),
		item_count: Number(row.item_count),
		created_at: timestamp(row, "created_at"),
		updated_at: timestamp(row, "updated_at"),
	};
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
		.replace(/-+$/g, "");
	return slug || "dataset";
}
function draft(row: Row) {
	return {
		id: text(row, "id"),
		project_id: text(row, "project_id"),
		dataset_id: text(row, "dataset_id"),
		base_version: row.base_version == null ? null : Number(row.base_version),
		revision: Number(row.revision),
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
function draftItem(row: Row) {
	return {
		item_key: text(row, "item_key"),
		input: jsonObject(row, "input"),
		expected_output:
			row.expected_output == null ? null : jsonObject(row, "expected_output"),
		metadata: jsonObject(row, "metadata"),
		source_trace_id: nullableText(row, "source_trace_id"),
		source_observation_id: nullableText(row, "source_observation_id"),
		position: Number(row.position),
	};
}

async function getDatasetRow(
	db: Queryable,
	projectId: string,
	datasetId: string,
) {
	const result = await db.query(
		`SELECT d.*, COALESCE((SELECT v.item_count FROM dataset_versions v WHERE v.dataset_id = d.id AND v.version = d.latest_published_version), 0)::int AS item_count FROM datasets d JOIN projects p ON p.id = d.project_id AND p.status = 'active' WHERE d.id = $1 AND d.project_id = $2 AND d.archived_at IS NULL`,
		[datasetId, projectId],
	);
	if (!result.rows[0])
		throw new DatasetRepositoryError("NOT_FOUND", "Dataset not found");
	return dataset(result.rows[0]);
}

export async function listDatasets(
	db: Transactional,
	input: { project_id: string; authorization: ProjectAuthorization },
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		const result = await client.query(
			`SELECT d.*, COALESCE((SELECT v.item_count FROM dataset_versions v WHERE v.dataset_id = d.id AND v.version = d.latest_published_version), 0)::int AS item_count FROM datasets d JOIN projects p ON p.id = d.project_id AND p.status = 'active' WHERE d.project_id = $1 AND d.archived_at IS NULL ORDER BY d.created_at DESC`,
			[input.project_id],
		);
		await client.query("COMMIT");
		return {
			items: result.rows.map(dataset),
			total: result.rowCount ?? result.rows.length,
		};
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function createDataset(
	db: Transactional,
	input: {
		project_id: string;
		name: string;
		slug?: string;
		description?: string | null;
		tags?: string[];
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		const baseSlug = input.slug ?? slugify(input.name);
		await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
			`dataset:${input.project_id}:${baseSlug}`,
		]);
		const reserved = await client.query(
			"SELECT 1 FROM dataset_tombstones WHERE project_id = $1 AND slug = $2",
			[input.project_id, baseSlug],
		);
		if (reserved.rows[0])
			throw new DatasetRepositoryError(
				"CONFLICT",
				"Dataset identifier has been deleted",
			);
		const result = await client.query(
			`INSERT INTO datasets (id, project_id, slug, name, description, tags) SELECT $1, $2, $3, $4, $5, $6::jsonb FROM projects WHERE id = $2 AND status = 'active' RETURNING *, 0::int AS item_count`,
			[
				randomUUID(),
				input.project_id,
				baseSlug,
				input.name,
				input.description ?? null,
				JSON.stringify(input.tags ?? []),
			],
		);
		if (!result.rows[0])
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		await lockProjectAuditProvenance(client, input.project_id);
		await client.query(
			"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type) VALUES ($1, $2, $3, $4, $5, 'created')",
			[
				input.authorization.organization_id,
				input.project_id,
				result.rows[0].id,
				baseSlug,
				input.authorization.actor_id,
			],
		);
		await client.query("COMMIT");
		return dataset(result.rows[0]);
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function getDataset(
	db: Transactional,
	input: {
		project_id: string;
		id: string;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		const value = await getDatasetRow(client, input.project_id, input.id);
		await client.query("COMMIT");
		return value;
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function getDatasetBySlug(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		const result = await client.query(
			`SELECT d.*, COALESCE((SELECT v.item_count FROM dataset_versions v WHERE v.dataset_id = d.id AND v.version = d.latest_published_version), 0)::int AS item_count FROM datasets d JOIN projects p ON p.id = d.project_id AND p.status = 'active' WHERE d.project_id = $1 AND d.slug = $2 AND d.archived_at IS NULL`,
			[input.project_id, input.slug],
		);
		if (!result.rows[0])
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset not found");
		await client.query("COMMIT");
		return dataset(result.rows[0]);
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function updateDatasetMetadata(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		name?: string;
		description?: string | null;
		tags?: string[];
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		await lockProjectAuditProvenance(client, input.project_id);
		const result = await client.query(
			`UPDATE datasets SET name = COALESCE($3, name), description = CASE WHEN $4::boolean THEN $5 ELSE description END, tags = COALESCE($6::jsonb, tags), updated_at = now() WHERE project_id = $1 AND slug = $2 AND archived_at IS NULL RETURNING *, COALESCE((SELECT v.item_count FROM dataset_versions v WHERE v.dataset_id = datasets.id AND v.version = datasets.latest_published_version), 0)::int AS item_count`,
			[
				input.project_id,
				input.slug,
				input.name ?? null,
				input.description !== undefined,
				input.description ?? null,
				input.tags === undefined ? null : JSON.stringify(input.tags),
			],
		);
		if (!result.rows[0])
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset not found");
		await client.query(
			"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type) VALUES ($1, $2, $3, $4, $5, 'metadata_updated')",
			[
				input.authorization.organization_id,
				input.project_id,
				result.rows[0].id,
				input.slug,
				input.authorization.actor_id,
			],
		);
		await client.query("COMMIT");
		return dataset(result.rows[0]);
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function getOrCreateDatasetDraft(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		const result = await client.query(
			`WITH selected AS (SELECT id, latest_published_version FROM datasets WHERE project_id = $1 AND slug = $2 AND archived_at IS NULL FOR UPDATE), inserted AS (INSERT INTO dataset_drafts (project_id, dataset_id, base_version, created_by) SELECT $1, id, latest_published_version, $3 FROM selected ON CONFLICT (dataset_id) DO NOTHING RETURNING *), copied AS (INSERT INTO dataset_draft_items (project_id, draft_id, item_key, position, input, expected_output, metadata, source_trace_id, source_observation_id) SELECT d.project_id, d.id, i.item_key, i.position, i.input, i.expected_output, i.metadata, i.source_trace_id, i.source_observation_id FROM inserted d JOIN dataset_versions v ON v.dataset_id = d.dataset_id AND v.version = d.base_version JOIN dataset_version_items i ON i.dataset_version_id = v.id), draft AS (SELECT * FROM inserted UNION ALL SELECT d.* FROM dataset_drafts d JOIN selected s ON s.id = d.dataset_id WHERE NOT EXISTS (SELECT 1 FROM inserted)) SELECT d.*, COUNT(i.id)::int AS item_count, EXISTS (SELECT 1 FROM inserted) AS created FROM draft d LEFT JOIN dataset_draft_items i ON i.draft_id = d.id GROUP BY d.id`,
			[input.project_id, input.slug, input.authorization.actor_id],
		);
		if (!result.rows[0])
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset not found");
		if (result.rows[0].created) {
			await lockProjectAuditProvenance(client, input.project_id);
			await client.query(
				"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type, draft_revision, item_count) VALUES ($1, $2, $3, $4, $5, 'draft_created', $6, $7)",
				[
					input.authorization.organization_id,
					input.project_id,
					result.rows[0].dataset_id,
					input.slug,
					input.authorization.actor_id,
					result.rows[0].revision,
					result.rows[0].item_count,
				],
			);
		}
		await client.query("COMMIT");
		return draft(result.rows[0]);
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function getDatasetDraft(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		const result = await client.query(
			`SELECT dr.*, COUNT(i.id)::int AS item_count FROM dataset_drafts dr JOIN datasets d ON d.id = dr.dataset_id AND d.project_id = dr.project_id LEFT JOIN dataset_draft_items i ON i.draft_id = dr.id WHERE d.project_id = $1 AND d.slug = $2 AND d.archived_at IS NULL GROUP BY dr.id`,
			[input.project_id, input.slug],
		);
		if (!result.rows[0])
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset draft not found");
		await client.query("COMMIT");
		return draft(result.rows[0]);
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function upsertDatasetDraftItem(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		item_key: string;
		revision: number;
		input: JsonObject;
		expected_output?: JsonObject | null;
		metadata?: JsonObject;
		source_trace_id?: string | null;
		source_observation_id?: string | null;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		const selected = await client.query(
			`SELECT dr.* FROM dataset_drafts dr JOIN datasets d ON d.id = dr.dataset_id AND d.project_id = dr.project_id WHERE d.project_id = $1 AND d.slug = $2 AND d.archived_at IS NULL FOR UPDATE`,
			[input.project_id, input.slug],
		);
		const row = selected.rows[0];
		if (!row)
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset draft not found");
		if (Number(row.revision) !== input.revision)
			throw new DatasetRepositoryError(
				"CONFLICT",
				"Dataset draft has changed; refresh and retry",
			);
		const result = await client.query(
			`INSERT INTO dataset_draft_items (project_id, draft_id, item_key, position, input, expected_output, metadata, source_trace_id, source_observation_id) VALUES ($1, $2, $3, COALESCE((SELECT position FROM dataset_draft_items WHERE draft_id = $2 AND item_key = $3), (SELECT COALESCE(MAX(position) + 1, 0) FROM dataset_draft_items WHERE draft_id = $2)), $4::jsonb, $5::jsonb, $6::jsonb, $7, $8) ON CONFLICT (draft_id, item_key) DO UPDATE SET input = EXCLUDED.input, expected_output = EXCLUDED.expected_output, metadata = EXCLUDED.metadata, source_trace_id = EXCLUDED.source_trace_id, source_observation_id = EXCLUDED.source_observation_id, updated_at = now() RETURNING *`,
			[
				input.project_id,
				row.id,
				input.item_key,
				JSON.stringify(input.input),
				input.expected_output == null
					? null
					: JSON.stringify(input.expected_output),
				JSON.stringify(input.metadata ?? {}),
				input.source_trace_id ?? null,
				input.source_observation_id ?? null,
			],
		);
		await client.query(
			"UPDATE dataset_drafts SET revision = revision + 1, updated_at = now() WHERE id = $1",
			[row.id],
		);
		await lockProjectAuditProvenance(client, input.project_id);
		await client.query(
			"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type, draft_revision) VALUES ($1, $2, $3, $4, $5, 'draft_item_upserted', $6)",
			[
				input.authorization.organization_id,
				input.project_id,
				row.dataset_id,
				input.slug,
				input.authorization.actor_id,
				Number(row.revision) + 1,
			],
		);
		await client.query("COMMIT");
		return draftItem(result.rows[0]);
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function deleteDatasetDraftItem(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		item_key: string;
		revision: number;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		const selected = await client.query(
			`SELECT dr.* FROM dataset_drafts dr JOIN datasets d ON d.id = dr.dataset_id AND d.project_id = dr.project_id WHERE d.project_id = $1 AND d.slug = $2 AND d.archived_at IS NULL FOR UPDATE`,
			[input.project_id, input.slug],
		);
		const row = selected.rows[0];
		if (!row)
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset draft not found");
		if (Number(row.revision) !== input.revision)
			throw new DatasetRepositoryError(
				"CONFLICT",
				"Dataset draft has changed; refresh and retry",
			);
		const removed = await client.query(
			"DELETE FROM dataset_draft_items WHERE draft_id = $1 AND item_key = $2 RETURNING id",
			[row.id, input.item_key],
		);
		if (!removed.rows[0])
			throw new DatasetRepositoryError(
				"NOT_FOUND",
				"Dataset draft item not found",
			);
		await client.query(
			"UPDATE dataset_drafts SET revision = revision + 1, updated_at = now() WHERE id = $1",
			[row.id],
		);
		await lockProjectAuditProvenance(client, input.project_id);
		await client.query(
			"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type, draft_revision) VALUES ($1, $2, $3, $4, $5, 'draft_item_deleted', $6)",
			[
				input.authorization.organization_id,
				input.project_id,
				row.dataset_id,
				input.slug,
				input.authorization.actor_id,
				Number(row.revision) + 1,
			],
		);
		await client.query("COMMIT");
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function discardDatasetDraft(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		const result = await client.query(
			`DELETE FROM dataset_drafts dr USING datasets d WHERE dr.dataset_id = d.id AND dr.project_id = d.project_id AND d.project_id = $1 AND d.slug = $2 AND d.archived_at IS NULL RETURNING dr.dataset_id, dr.revision`,
			[input.project_id, input.slug],
		);
		if (result.rowCount !== 1)
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset draft not found");
		await lockProjectAuditProvenance(client, input.project_id);
		await client.query(
			"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type, draft_revision) VALUES ($1, $2, $3, $4, $5, 'draft_discarded', $6)",
			[
				input.authorization.organization_id,
				input.project_id,
				result.rows[0].dataset_id,
				input.slug,
				input.authorization.actor_id,
				result.rows[0].revision,
			],
		);
		await client.query("COMMIT");
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function publishDatasetDraft(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		revision: number;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		const selected = await client.query(
			`SELECT dr.*, d.latest_published_version FROM dataset_drafts dr JOIN datasets d ON d.id = dr.dataset_id AND d.project_id = dr.project_id WHERE d.project_id = $1 AND d.slug = $2 AND d.archived_at IS NULL FOR UPDATE`,
			[input.project_id, input.slug],
		);
		const row = selected.rows[0];
		if (!row)
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset draft not found");
		if (Number(row.revision) !== input.revision)
			throw new DatasetRepositoryError(
				"CONFLICT",
				"Dataset draft has changed; refresh and retry",
			);
		const version = Number(row.latest_published_version ?? 0) + 1;
		const snapshot = await client.query(
			`WITH inserted AS (INSERT INTO dataset_versions (project_id, dataset_id, version, item_count, content_hash, created_via) SELECT $1, $2, $3, COUNT(*)::int, encode(digest(jsonb_build_object('schema', $4::jsonb, 'items', COALESCE(jsonb_agg(jsonb_build_object('item_key', item_key, 'input', input, 'expected_output', expected_output, 'metadata', metadata, 'source_trace_id', source_trace_id, 'source_observation_id', source_observation_id) ORDER BY position, item_key), '[]'::jsonb))::text, 'sha256'), 'hex'), 'draft_publish' FROM dataset_draft_items WHERE draft_id = $5 RETURNING id), copied AS (INSERT INTO dataset_version_items (project_id, dataset_version_id, item_key, position, input, expected_output, metadata, source_trace_id, source_observation_id) SELECT $1, inserted.id, i.item_key, i.position, i.input, i.expected_output, i.metadata, i.source_trace_id, i.source_observation_id FROM inserted JOIN dataset_draft_items i ON i.draft_id = $5 RETURNING id) UPDATE datasets SET latest_published_version = $3, updated_at = now() WHERE id = $2 RETURNING (SELECT id FROM inserted) AS version_id, (SELECT COUNT(*)::int FROM copied) AS item_count`,
			[
				input.project_id,
				row.dataset_id,
				version,
				JSON.stringify(row.schema ?? {}),
				row.id,
			],
		);
		await client.query(
			`UPDATE feedback_reviews r SET dataset_draft_item_id = NULL, dataset_item_id = v.id, updated_at = now() FROM dataset_draft_items d JOIN dataset_version_items v ON v.dataset_version_id = $1 AND v.item_key = d.item_key WHERE r.dataset_draft_item_id = d.id AND d.draft_id = $2`,
			[snapshot.rows[0]?.version_id, row.id],
		);
		await client.query("DELETE FROM dataset_drafts WHERE id = $1", [row.id]);
		await lockProjectAuditProvenance(client, input.project_id);
		await client.query(
			"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type, draft_revision, item_count) VALUES ($1, $2, $3, $4, $5, 'draft_published', $6, $7)",
			[
				input.authorization.organization_id,
				input.project_id,
				row.dataset_id,
				input.slug,
				input.authorization.actor_id,
				input.revision,
				snapshot.rows[0]?.item_count ?? 0,
			],
		);
		await client.query("COMMIT");
		return { version, item_count: Number(snapshot.rows[0]?.item_count ?? 0) };
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function archiveDataset(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		await lockProjectAuditProvenance(client, input.project_id);
		const result = await client.query(
			"UPDATE datasets SET archived_at = now(), archived_by = $3, updated_at = now() WHERE project_id = $1 AND slug = $2 AND archived_at IS NULL RETURNING id",
			[input.project_id, input.slug, input.authorization.actor_id],
		);
		if (!result.rows[0])
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset not found");
		await client.query(
			"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type) VALUES ($1, $2, $3, $4, $5, 'archived')",
			[
				input.authorization.organization_id,
				input.project_id,
				result.rows[0].id,
				input.slug,
				input.authorization.actor_id,
			],
		);
		await client.query("COMMIT");
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function listDatasetItems(
	db: Transactional,
	input: {
		project_id: string;
		dataset_id: string;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		await getDatasetRow(client, input.project_id, input.dataset_id);
		const result = await client.query(
			`WITH selected_draft AS (SELECT dr.id FROM dataset_drafts dr WHERE dr.dataset_id = $1), visible_items AS (SELECT i.item_key AS id, $1::uuid AS dataset_id, i.input, i.expected_output, i.metadata, i.source_trace_id, i.source_observation_id, i.created_at, i.position FROM dataset_draft_items i JOIN selected_draft d ON d.id = i.draft_id UNION ALL SELECT i.id::text, $1::uuid, i.input, i.expected_output, i.metadata, i.source_trace_id, i.source_observation_id, i.created_at, i.position FROM dataset_version_items i JOIN dataset_versions v ON v.id = i.dataset_version_id JOIN datasets d ON d.id = v.dataset_id AND v.version = d.latest_published_version WHERE d.id = $1 AND NOT EXISTS (SELECT 1 FROM selected_draft)) SELECT i.id, i.dataset_id, i.input, i.expected_output, i.metadata, i.source_trace_id, i.source_observation_id, i.created_at FROM visible_items i JOIN datasets d ON d.id = i.dataset_id JOIN projects p ON p.id = d.project_id AND p.status = 'active' WHERE d.project_id = $2 ORDER BY i.position ASC, i.created_at ASC, i.id ASC`,
			[input.dataset_id, input.project_id],
		);
		await client.query("COMMIT");
		return { items: result.rows.map(item) };
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function listPublishedDatasetItems(
	db: Transactional,
	input: {
		project_id: string;
		dataset_id: string;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		await getDatasetRow(client, input.project_id, input.dataset_id);
		const result = await client.query(
			`SELECT i.id::text AS id, $1::uuid AS dataset_id, i.input, i.expected_output, i.metadata, i.source_trace_id, i.source_observation_id, i.created_at FROM dataset_version_items i JOIN dataset_versions v ON v.id = i.dataset_version_id JOIN datasets d ON d.id = v.dataset_id AND v.version = d.latest_published_version JOIN projects p ON p.id = d.project_id AND p.status = 'active' WHERE d.id = $1 AND d.project_id = $2 ORDER BY i.position ASC, i.created_at ASC, i.id ASC`,
			[input.dataset_id, input.project_id],
		);
		await client.query("COMMIT");
		return { items: result.rows.map(item) };
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function addDatasetItem(
	db: Transactional,
	input: {
		project_id: string;
		dataset_id: string;
		input: JsonObject;
		expected_output?: JsonObject | null;
		metadata?: JsonObject;
		source_trace_id?: string | null;
		source_observation_id?: string | null;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		throw new DatasetRepositoryError(
			"CONFLICT",
			"Legacy dataset item writes are not supported; edit the dataset draft instead",
		);
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function deleteDatasetItem(
	db: Transactional,
	input: {
		project_id: string;
		dataset_id: string;
		item_id: string;
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
			throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
		throw new DatasetRepositoryError(
			"CONFLICT",
			"Legacy dataset item writes are not supported; edit the dataset draft instead",
		);
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}
