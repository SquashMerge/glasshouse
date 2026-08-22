import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	DATASET_DRAFT_VALIDATION_VERSION,
	type DatasetDraftItemInput,
	type DatasetDraftValidationIssue,
	validateDatasetDraftItem,
} from "../lib/dataset-draft-validation.js";
import { approvedRedaction } from "./governance.js";
import {
	lockActiveAuthorizedProject,
	lockProjectAuditProvenance,
	type ProjectAuthorization,
} from "./project-authorization.js";
import { policyRedactionOptions, redactDatasetCapture } from "./redact.js";

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
		readonly details?: Record<string, unknown>,
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

export async function lockDatasetSlugForCreate(
	client: Pick<PoolClient, "query">,
	projectId: string,
	slug: string,
) {
	await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
		`dataset:${projectId}:${slug}`,
	]);
	const reserved = await client.query(
		"SELECT 1 FROM dataset_tombstones WHERE project_id = $1 AND slug = $2",
		[projectId, slug],
	);
	if (reserved.rows[0])
		throw new DatasetRepositoryError(
			"CONFLICT",
			"Dataset identifier has been deleted",
		);
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
function jsonObjectOrEmpty(row: Row, key: string): JsonObject {
	if (row[key] === undefined || row[key] === null) return {};
	return jsonObject(row, key);
}
function timestamp(row: Row, key: string): string {
	const value = row[key];
	return value instanceof Date ? value.toISOString() : text(row, key);
}
function nullableTimestamp(row: Row, key: string): string | null {
	return row[key] == null ? null : timestamp(row, key);
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
function datasetVersion(row: Row) {
	return {
		id: text(row, "id"),
		dataset_id: text(row, "dataset_id"),
		project_id: text(row, "project_id"),
		version: Number(row.version),
		item_count: Number(row.item_count),
		content_hash: text(row, "content_hash"),
		validation_version: Number(row.validation_version ?? 1),
		published_by: nullableText(row, "published_by"),
		published_draft_revision:
			row.published_draft_revision == null
				? null
				: Number(row.published_draft_revision),
		created_at: timestamp(row, "created_at"),
	};
}
function datasetVersionItem(row: Row) {
	return {
		id: text(row, "id"),
		item_key: text(row, "item_key"),
		position: Number(row.position),
		validation_version: Number(row.validation_version ?? 1),
		state: row.state === "draft" ? "draft" : "reviewed",
		input: jsonObject(row, "input"),
		expected_output:
			row.expected_output == null ? null : jsonObject(row, "expected_output"),
		metadata: jsonObjectOrEmpty(row, "metadata"),
		external_id: nullableText(row, "external_id"),
		source_trace_id: nullableText(row, "source_trace_id"),
		source_observation_id: nullableText(row, "source_observation_id"),
		feedback_score_id: nullableText(row, "feedback_score_id"),
		capture_context: jsonObjectOrEmpty(row, "capture_context"),
		curated_by: nullableText(row, "curated_by"),
		reviewed_by: nullableText(row, "reviewed_by"),
		reviewed_at: nullableTimestamp(row, "reviewed_at"),
		created_at: timestamp(row, "created_at"),
	};
}
function item(row: Row) {
	return {
		id: text(row, "id"),
		dataset_id: text(row, "dataset_id"),
		item_key: nullableText(row, "item_key"),
		validation_version: Number(row.validation_version ?? 1),
		state: row.state === "draft" ? "draft" : "reviewed",
		input: jsonObject(row, "input"),
		expected_output:
			row.expected_output == null ? null : jsonObject(row, "expected_output"),
		metadata: jsonObjectOrEmpty(row, "metadata"),
		external_id: nullableText(row, "external_id"),
		source_trace_id: nullableText(row, "source_trace_id"),
		source_observation_id: nullableText(row, "source_observation_id"),
		source_feedback_id: nullableText(row, "feedback_score_id"),
		capture_context: jsonObjectOrEmpty(row, "capture_context"),
		created_by:
			nullableText(row, "created_by") ?? nullableText(row, "curated_by"),
		updated_by: nullableText(row, "updated_by"),
		reviewed_by: nullableText(row, "reviewed_by"),
		reviewed_at: nullableTimestamp(row, "reviewed_at"),
		created_at: timestamp(row, "created_at"),
	};
}
function draftItem(row: Row) {
	return {
		id: text(row, "id"),
		item_key: text(row, "item_key"),
		validation_version: Number(row.validation_version ?? 1),
		state: row.state === "draft" ? "draft" : "reviewed",
		input: jsonObject(row, "input"),
		expected_output:
			row.expected_output == null ? null : jsonObject(row, "expected_output"),
		metadata: jsonObjectOrEmpty(row, "metadata"),
		external_id: nullableText(row, "external_id"),
		source_trace_id: nullableText(row, "source_trace_id"),
		source_observation_id: nullableText(row, "source_observation_id"),
		source_feedback_id: nullableText(row, "feedback_score_id"),
		capture_context: jsonObjectOrEmpty(row, "capture_context"),
		created_by: nullableText(row, "created_by"),
		updated_by: nullableText(row, "updated_by"),
		reviewed_by: nullableText(row, "reviewed_by"),
		reviewed_at: nullableTimestamp(row, "reviewed_at"),
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
		await lockProjectAuditProvenance(client, input.project_id);
		await lockDatasetSlugForCreate(client, input.project_id, baseSlug);
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

export async function listDatasetVersions(
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
		const dataset = await client.query(
			"SELECT id FROM datasets WHERE project_id = $1 AND slug = $2 AND archived_at IS NULL FOR SHARE",
			[input.project_id, input.slug],
		);
		if (!dataset.rows[0])
			throw new DatasetRepositoryError("NOT_FOUND", "Dataset not found");
		const result = await client.query(
			"SELECT version.* FROM dataset_versions version JOIN datasets dataset ON dataset.id = version.dataset_id AND dataset.project_id = version.project_id WHERE dataset.project_id = $1 AND dataset.slug = $2 AND dataset.archived_at IS NULL ORDER BY version.version DESC",
			[input.project_id, input.slug],
		);
		await client.query("COMMIT");
		return { items: result.rows.map(datasetVersion) };
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function getDatasetVersion(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		version: number;
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
			"SELECT version.* FROM dataset_versions version JOIN datasets dataset ON dataset.id = version.dataset_id AND dataset.project_id = version.project_id WHERE dataset.project_id = $1 AND dataset.slug = $2 AND dataset.archived_at IS NULL AND version.version = $3",
			[input.project_id, input.slug, input.version],
		);
		if (!result.rows[0])
			throw new DatasetRepositoryError(
				"NOT_FOUND",
				"Dataset version not found",
			);
		const items = await client.query(
			"SELECT id, item_key, position, validation_version, state, input, expected_output, metadata, external_id, source_trace_id, source_observation_id, feedback_score_id, capture_context, curated_by, reviewed_by, reviewed_at, created_at FROM dataset_version_items WHERE project_id = $1 AND dataset_version_id = $2 ORDER BY position ASC, created_at ASC, id ASC",
			[input.project_id, result.rows[0].id],
		);
		await client.query("COMMIT");
		return {
			...datasetVersion(result.rows[0]),
			items: items.rows.map(datasetVersionItem),
		};
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

async function getOrCreateDatasetDraftInTransaction(
	client: Pick<PoolClient, "query">,
	input: {
		project_id: string;
		slug: string;
		authorization: ProjectAuthorization;
	},
) {
	if (
		!(await lockActiveAuthorizedProject(
			client,
			input.project_id,
			input.authorization,
		))
	)
		throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
	const result = await client.query(
		`WITH selected AS (SELECT id, latest_published_version FROM datasets WHERE project_id = $1 AND slug = $2 AND archived_at IS NULL FOR UPDATE), inserted AS (INSERT INTO dataset_drafts (project_id, dataset_id, base_version, created_by) SELECT $1, id, latest_published_version, $3 FROM selected ON CONFLICT (dataset_id) DO NOTHING RETURNING *), copied AS (INSERT INTO dataset_draft_items (project_id, draft_id, item_key, position, input, expected_output, metadata, external_id, source_trace_id, source_observation_id, feedback_score_id, validation_version, state, capture_context, created_by, updated_by, reviewed_by, reviewed_at) SELECT d.project_id, d.id, i.item_key, i.position, i.input, i.expected_output, i.metadata, i.external_id, i.source_trace_id, i.source_observation_id, i.feedback_score_id, i.validation_version, i.state, i.capture_context, COALESCE(i.curated_by, d.created_by), COALESCE(i.curated_by, d.created_by), i.reviewed_by, i.reviewed_at FROM inserted d JOIN dataset_versions v ON v.dataset_id = d.dataset_id AND v.version = d.base_version JOIN dataset_version_items i ON i.dataset_version_id = v.id RETURNING draft_id), draft AS (SELECT * FROM inserted UNION ALL SELECT d.* FROM dataset_drafts d JOIN selected s ON s.id = d.dataset_id WHERE NOT EXISTS (SELECT 1 FROM inserted)) SELECT d.*, CASE WHEN EXISTS (SELECT 1 FROM inserted) THEN (SELECT COUNT(*)::int FROM copied c WHERE c.draft_id = d.id) ELSE (SELECT COUNT(*)::int FROM dataset_draft_items i WHERE i.draft_id = d.id) END AS item_count, EXISTS (SELECT 1 FROM inserted) AS created FROM draft d`,
		[input.project_id, input.slug, input.authorization.actor_id],
	);
	const row = result.rows[0] as Row | undefined;
	if (!row) throw new DatasetRepositoryError("NOT_FOUND", "Dataset not found");
	const created = row.created === true;
	if (created) {
		await lockProjectAuditProvenance(client, input.project_id);
		await client.query(
			"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type, draft_revision, item_count) VALUES ($1, $2, $3, $4, $5, 'draft_created', $6, $7)",
			[
				input.authorization.organization_id,
				input.project_id,
				row.dataset_id,
				input.slug,
				input.authorization.actor_id,
				row.revision,
				row.item_count,
			],
		);
	}
	return { row, created };
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
		const result = await getOrCreateDatasetDraftInTransaction(client, input);
		await client.query("COMMIT");
		return draft(result.row);
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

type DraftItemWriteInput = DatasetDraftItemInput & {
	project_id: string;
	item_key: string;
	feedback_score_id?: string | null;
	capture_context?: JsonObject;
	capture?: boolean;
};

type DraftItemRevisionAction =
	| "upserted"
	| "captured"
	| "imported"
	| "reviewed"
	| "reordered";

function validationFailure(
	issues: DatasetDraftValidationIssue[],
	itemKey: string | null,
	itemId: string | null = null,
): DatasetRepositoryError {
	return new DatasetRepositoryError(
		"BAD_REQUEST",
		"Dataset draft validation failed",
		undefined,
		{
			errors: issues.map((issue) => ({
				item_id: itemId,
				item_key: itemKey,
				...issue,
			})),
		},
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

export function datasetCurationRequestHash(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function lockDatasetDraft(
	client: Pick<PoolClient, "query">,
	projectId: string,
	slug: string,
) {
	const selected = await client.query(
		`SELECT dr.* FROM dataset_drafts dr JOIN datasets d ON d.id = dr.dataset_id AND d.project_id = dr.project_id WHERE d.project_id = $1 AND d.slug = $2 AND d.archived_at IS NULL FOR UPDATE`,
		[projectId, slug],
	);
	const row = selected.rows[0];
	if (!row)
		throw new DatasetRepositoryError("NOT_FOUND", "Dataset draft not found");
	return row as Row;
}

async function curationDraft(
	client: Pick<PoolClient, "query">,
	input: {
		project_id: string;
		slug: string;
		revision?: number;
		authorization: ProjectAuthorization;
	},
	allowExistingWithoutRevision = false,
) {
	if (input.revision !== undefined || allowExistingWithoutRevision) {
		const row = await lockDatasetDraft(client, input.project_id, input.slug);
		requireDraftRevision(row, input.revision);
		return row;
	}
	const result = await getOrCreateDatasetDraftInTransaction(client, input);
	if (!result.created)
		throw new DatasetRepositoryError(
			"CONFLICT",
			"Draft revision is required when a shared draft already exists",
		);
	return result.row;
}

async function lockCurationDataset(
	client: Pick<PoolClient, "query">,
	projectId: string,
	slug: string,
): Promise<string> {
	const selected = await client.query(
		"SELECT id FROM datasets WHERE project_id = $1 AND slug = $2 FOR UPDATE",
		[projectId, slug],
	);
	const row = selected.rows[0];
	if (!row)
		throw new DatasetRepositoryError("NOT_FOUND", "Dataset draft not found");
	return text(row as Row, "id");
}

async function lockCurationDatasetById(
	client: Pick<PoolClient, "query">,
	projectId: string,
	datasetId: string,
): Promise<string> {
	const selected = await client.query(
		"SELECT id FROM datasets WHERE project_id = $1 AND id = $2 FOR UPDATE",
		[projectId, datasetId],
	);
	const row = selected.rows[0];
	if (!row)
		throw new DatasetRepositoryError("NOT_FOUND", "Dataset draft not found");
	return text(row as Row, "id");
}

function requireDraftRevision(row: Row, revision: number | undefined): void {
	if (revision === undefined) return;
	if (Number(row.revision) !== revision)
		throw new DatasetRepositoryError(
			"CONFLICT",
			"Dataset draft has changed; refresh and retry",
		);
}

async function incrementDraftRevision(
	client: Pick<PoolClient, "query">,
	draftId: string,
): Promise<number> {
	const result = await client.query(
		"UPDATE dataset_drafts SET revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING revision",
		[draftId],
	);
	return Number(result.rows[0]?.revision);
}

async function recordDraftAudit(
	client: Pick<PoolClient, "query">,
	input: {
		project_id: string;
		slug: string;
		dataset_id: string;
		authorization: ProjectAuthorization;
		event_type:
			| "draft_item_upserted"
			| "draft_item_captured"
			| "draft_item_reviewed"
			| "draft_items_imported"
			| "draft_items_reordered";
		revision: number;
	},
): Promise<void> {
	await lockProjectAuditProvenance(client, input.project_id);
	await client.query(
		"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type, draft_revision) VALUES ($1, $2, $3, $4, $5, $6, $7)",
		[
			input.authorization.organization_id,
			input.project_id,
			input.dataset_id,
			input.slug,
			input.authorization.actor_id,
			input.event_type,
			input.revision,
		],
	);
}

async function appendDraftItemRevision(
	client: Pick<PoolClient, "query">,
	row: Row,
	datasetId: string,
	actorId: string,
	action: DraftItemRevisionAction,
): Promise<void> {
	await client.query(
		`INSERT INTO dataset_draft_item_revisions (project_id, dataset_id, draft_item_id, item_revision, item_key, position, validation_version, state, input, expected_output, metadata, external_id, source_trace_id, source_observation_id, feedback_score_id, capture_context, actor_id, action) VALUES ($1, $2, $3, (SELECT COALESCE(MAX(item_revision) + 1, 1) FROM dataset_draft_item_revisions WHERE draft_item_id = $3), $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14::uuid, $15::jsonb, $16::uuid, $17)`,
		[
			text(row, "project_id"),
			datasetId,
			text(row, "id"),
			text(row, "item_key"),
			Number(row.position),
			Number(row.validation_version ?? DATASET_DRAFT_VALIDATION_VERSION),
			row.state === "draft" ? "draft" : "reviewed",
			JSON.stringify(jsonObject(row, "input")),
			row.expected_output == null
				? null
				: JSON.stringify(jsonObject(row, "expected_output")),
			JSON.stringify(jsonObjectOrEmpty(row, "metadata")),
			nullableText(row, "external_id"),
			nullableText(row, "source_trace_id"),
			nullableText(row, "source_observation_id"),
			nullableText(row, "feedback_score_id"),
			JSON.stringify(jsonObjectOrEmpty(row, "capture_context")),
			actorId,
			action,
		],
	);
}

async function writeDraftItem(
	client: Pick<PoolClient, "query">,
	draft: Row,
	input: DraftItemWriteInput,
	authorization: ProjectAuthorization,
	options: { capture: boolean; action: DraftItemRevisionAction },
) {
	let payload: DatasetDraftItemInput = {
		input: input.input,
		expected_output: input.expected_output ?? null,
		metadata: input.metadata ?? {},
		external_id: input.external_id ?? null,
		source_trace_id: input.source_trace_id ?? null,
		source_observation_id: input.source_observation_id ?? null,
	};
	let captureContext = input.capture_context ?? {};
	if (options.capture) {
		const policy = await approvedRedaction(
			client as Pick<Pool, "query">,
			authorization.organization_id,
			input.project_id as string,
		);
		const redaction = policyRedactionOptions(
			policy ?? { mode: "none", keys: [] },
		);
		const capturedInput = redactDatasetCapture(payload.input, redaction);
		const capturedExpected = payload.expected_output
			? redactDatasetCapture(payload.expected_output, redaction)
			: null;
		payload = {
			...payload,
			input: capturedInput.value,
			expected_output: capturedExpected?.value ?? null,
		};
		captureContext = {
			...captureContext,
			redaction_applied:
				capturedInput.redacted || Boolean(capturedExpected?.redacted),
		};
	}
	const issues = validateDatasetDraftItem(payload);
	if (issues.length) throw validationFailure(issues, input.item_key);
	const result = await client.query(
		`INSERT INTO dataset_draft_items (project_id, draft_id, item_key, position, input, expected_output, metadata, external_id, source_trace_id, source_observation_id, feedback_score_id, validation_version, state, capture_context, created_by, updated_by, reviewed_by, reviewed_at) VALUES ($1, $2, $3, COALESCE((SELECT position FROM dataset_draft_items WHERE draft_id = $2 AND item_key = $3), (SELECT COALESCE(MAX(position) + 1, 0) FROM dataset_draft_items WHERE draft_id = $2)), $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10::uuid, $11, 'draft', $12::jsonb, $13::uuid, $13::uuid, NULL, NULL) ON CONFLICT (draft_id, item_key) DO UPDATE SET input = EXCLUDED.input, expected_output = EXCLUDED.expected_output, metadata = EXCLUDED.metadata, external_id = EXCLUDED.external_id, source_trace_id = EXCLUDED.source_trace_id, source_observation_id = EXCLUDED.source_observation_id, feedback_score_id = COALESCE(dataset_draft_items.feedback_score_id, EXCLUDED.feedback_score_id), validation_version = EXCLUDED.validation_version, state = 'draft', capture_context = EXCLUDED.capture_context, updated_by = EXCLUDED.updated_by, reviewed_by = NULL, reviewed_at = NULL, updated_at = now() RETURNING *`,
		[
			input.project_id,
			draft.id,
			input.item_key,
			JSON.stringify(payload.input),
			payload.expected_output == null
				? null
				: JSON.stringify(payload.expected_output),
			JSON.stringify(payload.metadata ?? {}),
			payload.external_id ?? null,
			payload.source_trace_id ?? null,
			payload.source_observation_id ?? null,
			input.feedback_score_id ?? null,
			DATASET_DRAFT_VALIDATION_VERSION,
			JSON.stringify(captureContext),
			authorization.actor_id,
		],
	);
	const row = result.rows[0] as Row | undefined;
	if (!row)
		throw new DatasetRepositoryError(
			"INTERNAL",
			"Dataset draft item was not saved",
		);
	await appendDraftItemRevision(
		client,
		row,
		text(draft, "dataset_id"),
		authorization.actor_id,
		options.action,
	);
	return draftItem(row);
}

export async function mutateDatasetDraftItemInTransaction(
	client: Pick<PoolClient, "query">,
	input: DraftItemWriteInput & {
		project_id: string;
		slug: string;
		revision?: number;
		authorization: ProjectAuthorization;
		action?: "upserted" | "captured";
		capture?: boolean;
	},
) {
	if (
		!(await lockActiveAuthorizedProject(
			client,
			input.project_id,
			input.authorization,
		))
	)
		throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
	const draftRow = await lockDatasetDraft(client, input.project_id, input.slug);
	requireDraftRevision(draftRow, input.revision);
	const action = input.action ?? "upserted";
	const item = await writeDraftItem(
		client,
		draftRow,
		input,
		input.authorization,
		{
			capture: input.capture ?? false,
			action,
		},
	);
	const revision = await incrementDraftRevision(client, text(draftRow, "id"));
	await recordDraftAudit(client, {
		project_id: input.project_id,
		slug: input.slug,
		dataset_id: text(draftRow, "dataset_id"),
		authorization: input.authorization,
		event_type:
			action === "captured" ? "draft_item_captured" : "draft_item_upserted",
		revision,
	});
	return { item, revision, draft_id: text(draftRow, "id") };
}

export async function upsertDatasetDraftItem(
	db: Transactional,
	input: DraftItemWriteInput & {
		project_id: string;
		slug: string;
		revision: number;
		authorization: ProjectAuthorization;
	},
) {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		const result = await mutateDatasetDraftItemInTransaction(client, input);
		await client.query("COMMIT");
		return result.item;
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

type DraftValidationError = DatasetDraftValidationIssue & {
	item_id: string | null;
	item_key: string | null;
};

function validatePersistedDraftItems(
	rows: Row[],
	requireReviewed: boolean,
): DraftValidationError[] {
	return rows.flatMap((row) => {
		const candidate = draftItem(row);
		const errors = validateDatasetDraftItem({
			input: candidate.input,
			expected_output: candidate.expected_output,
			metadata: candidate.metadata,
			external_id: candidate.external_id,
			source_trace_id: candidate.source_trace_id,
			source_observation_id: candidate.source_observation_id,
		});
		if (candidate.validation_version !== DATASET_DRAFT_VALIDATION_VERSION)
			errors.push({
				field: "validation_version",
				code: "UNSUPPORTED_VERSION",
				message: "Dataset item uses an unsupported validation version",
			});
		if (requireReviewed && candidate.state !== "reviewed")
			errors.push({
				field: "state",
				code: "REVIEW_REQUIRED",
				message: "Dataset draft items must be reviewed before publication",
			});
		return errors.map((error) => ({
			...error,
			item_id: candidate.id,
			item_key: candidate.item_key,
		}));
	});
}

function persistedValidationFailure(
	errors: DraftValidationError[],
): DatasetRepositoryError {
	return new DatasetRepositoryError(
		"BAD_REQUEST",
		"Dataset draft validation failed",
		undefined,
		{ errors },
	);
}

export async function validateDatasetDraft(
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
		const draftRow = await lockDatasetDraft(
			client,
			input.project_id,
			input.slug,
		);
		const items = await client.query(
			"SELECT * FROM dataset_draft_items WHERE draft_id = $1 ORDER BY position, item_key FOR KEY SHARE",
			[text(draftRow, "id")],
		);
		const errors = validatePersistedDraftItems(items.rows as Row[], true);
		await client.query("COMMIT");
		return {
			validation_version: DATASET_DRAFT_VALIDATION_VERSION,
			valid: errors.length === 0,
			errors,
		};
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function getDatasetDraftItemRevisions(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
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
		const result = await client.query(
			`SELECT revision.*, COALESCE(revision.dataset_version_item_id, revision.draft_item_id) AS item_id FROM dataset_draft_item_revisions revision JOIN datasets dataset ON dataset.id = revision.dataset_id AND dataset.project_id = revision.project_id WHERE dataset.project_id = $1 AND dataset.slug = $2 AND dataset.archived_at IS NULL AND (revision.draft_item_id = $3::uuid OR EXISTS (SELECT 1 FROM dataset_version_items item JOIN dataset_versions version ON version.id = item.dataset_version_id AND version.project_id = item.project_id WHERE item.project_id = revision.project_id AND item.id = revision.dataset_version_item_id AND version.dataset_id = revision.dataset_id AND item.id = $3::uuid)) ORDER BY revision.item_revision DESC`,
			[input.project_id, input.slug, input.item_id],
		);
		if (!result.rows.length) {
			const exists = await client.query(
				`SELECT 1 FROM datasets dataset WHERE dataset.project_id = $1 AND dataset.slug = $2 AND dataset.archived_at IS NULL AND (EXISTS (SELECT 1 FROM dataset_draft_items item JOIN dataset_drafts draft ON draft.id = item.draft_id AND draft.project_id = item.project_id WHERE draft.dataset_id = dataset.id AND item.id = $3::uuid) OR EXISTS (SELECT 1 FROM dataset_version_items item JOIN dataset_versions version ON version.id = item.dataset_version_id AND version.project_id = item.project_id WHERE version.dataset_id = dataset.id AND item.id = $3::uuid))`,
				[input.project_id, input.slug, input.item_id],
			);
			if (!exists.rows[0])
				throw new DatasetRepositoryError(
					"NOT_FOUND",
					"Dataset draft item not found",
				);
		}
		await client.query("COMMIT");
		return {
			items: result.rows.map((row) => ({
				...draftItem(row),
				id: text(row as Row, "item_id"),
				item_revision: Number(row.item_revision),
				action: text(row, "action"),
				actor_id: text(row, "actor_id"),
				created_at: timestamp(row, "created_at"),
			})),
		};
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function reviewDatasetDraftItem(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		item_id: string;
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
		const draftRow = await lockDatasetDraft(
			client,
			input.project_id,
			input.slug,
		);
		requireDraftRevision(draftRow, input.revision);
		const reviewed = await client.query(
			"UPDATE dataset_draft_items SET state = 'reviewed', validation_version = $3, updated_by = $4::uuid, reviewed_by = $4::uuid, reviewed_at = now(), updated_at = now() WHERE draft_id = $1 AND id = $2::uuid RETURNING *",
			[
				text(draftRow, "id"),
				input.item_id,
				DATASET_DRAFT_VALIDATION_VERSION,
				input.authorization.actor_id,
			],
		);
		const row = reviewed.rows[0] as Row | undefined;
		if (!row)
			throw new DatasetRepositoryError(
				"NOT_FOUND",
				"Dataset draft item not found",
			);
		const issues = validateDatasetDraftItem({
			input: jsonObject(row, "input"),
			expected_output:
				row.expected_output == null ? null : jsonObject(row, "expected_output"),
			metadata: jsonObjectOrEmpty(row, "metadata"),
			external_id: nullableText(row, "external_id"),
			source_trace_id: nullableText(row, "source_trace_id"),
			source_observation_id: nullableText(row, "source_observation_id"),
		});
		if (issues.length)
			throw validationFailure(issues, text(row, "item_key"), text(row, "id"));
		await appendDraftItemRevision(
			client,
			row,
			text(draftRow, "dataset_id"),
			input.authorization.actor_id,
			"reviewed",
		);
		const revision = await incrementDraftRevision(client, text(draftRow, "id"));
		await recordDraftAudit(client, {
			project_id: input.project_id,
			slug: input.slug,
			dataset_id: text(draftRow, "dataset_id"),
			authorization: input.authorization,
			event_type: "draft_item_reviewed",
			revision,
		});
		await client.query("COMMIT");
		return { item: draftItem(row), revision };
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function reorderDatasetDraftItems(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		item_ids: string[];
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
		const draftRow = await lockDatasetDraft(
			client,
			input.project_id,
			input.slug,
		);
		requireDraftRevision(draftRow, input.revision);
		const current = await client.query(
			"SELECT id FROM dataset_draft_items WHERE draft_id = $1 ORDER BY position, item_key FOR UPDATE",
			[text(draftRow, "id")],
		);
		const currentIds = current.rows.map((row) => text(row, "id"));
		if (
			currentIds.length !== input.item_ids.length ||
			currentIds.some((id) => !input.item_ids.includes(id))
		)
			throw new DatasetRepositoryError(
				"BAD_REQUEST",
				"Draft ordering must contain every current item exactly once",
			);
		await client.query(
			"UPDATE dataset_draft_items SET position = position + $2 WHERE draft_id = $1",
			[text(draftRow, "id"), currentIds.length + 1],
		);
		const reordered = await client.query(
			"WITH requested AS (SELECT id::uuid, ordinality - 1 AS position FROM unnest($1::text[]) WITH ORDINALITY AS requested(id, ordinality)) UPDATE dataset_draft_items item SET position = requested.position, updated_by = $3::uuid, updated_at = now() FROM requested WHERE item.draft_id = $2 AND item.id = requested.id RETURNING item.*",
			[input.item_ids, text(draftRow, "id"), input.authorization.actor_id],
		);
		for (const row of reordered.rows as Row[])
			await appendDraftItemRevision(
				client,
				row,
				text(draftRow, "dataset_id"),
				input.authorization.actor_id,
				"reordered",
			);
		const revision = await incrementDraftRevision(client, text(draftRow, "id"));
		await recordDraftAudit(client, {
			project_id: input.project_id,
			slug: input.slug,
			dataset_id: text(draftRow, "dataset_id"),
			authorization: input.authorization,
			event_type: "draft_items_reordered",
			revision,
		});
		await client.query("COMMIT");
		return { revision };
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export type DatasetCurationReplay = {
	draft_id: string;
	revision: number;
	item_ids: string[];
};

export type DatasetCurationOperation =
	| "import"
	| "capture"
	| "feedback_promotion";

function idempotencyResponse(row: Row): DatasetCurationReplay {
	const response = jsonObject(row, "response");
	if (
		typeof response.draft_id !== "string" ||
		typeof response.revision !== "number" ||
		!Array.isArray(response.item_ids) ||
		!response.item_ids.every((id) => typeof id === "string")
	)
		throw new DatasetRepositoryError(
			"INTERNAL",
			"Dataset curation idempotency record is invalid",
		);
	return response as DatasetCurationReplay;
}

function curationRequestHashes(dataset_id: string, request: unknown) {
	return {
		legacy_request_hash: datasetCurationRequestHash(request),
		request_hash: datasetCurationRequestHash({
			...(request as Record<string, unknown>),
			dataset_id,
		}),
	};
}

async function readCurationIdempotency(
	client: Pick<PoolClient, "query">,
	input: {
		project_id: string;
		authorization: ProjectAuthorization;
		operation: DatasetCurationOperation;
		idempotency_key: string;
		dataset_id: string;
		request_hash: string;
		legacy_request_hashes: readonly string[];
	},
): Promise<DatasetCurationReplay | null> {
	const existing = await client.query(
		"SELECT dataset_id, request_hash, response FROM dataset_curation_idempotency WHERE project_id = $1 AND actor_id = $2 AND operation = $3 AND idempotency_key = $4 FOR UPDATE",
		[
			input.project_id,
			input.authorization.actor_id,
			input.operation,
			input.idempotency_key,
		],
	);
	if (!existing.rows[0]) return null;
	const row = existing.rows[0] as Row;
	if (nullableText(row, "dataset_id") !== input.dataset_id)
		throw new DatasetRepositoryError(
			"CONFLICT",
			"Idempotency key was already used with a different request",
		);
	const storedRequestHash = text(row, "request_hash");
	if (
		storedRequestHash !== input.request_hash &&
		!input.legacy_request_hashes.includes(storedRequestHash)
	)
		throw new DatasetRepositoryError(
			"CONFLICT",
			"Idempotency key was already used with a different request",
		);
	if (storedRequestHash !== input.request_hash)
		await client.query(
			"UPDATE dataset_curation_idempotency SET request_hash = $1 WHERE project_id = $2 AND actor_id = $3 AND operation = $4 AND idempotency_key = $5",
			[
				input.request_hash,
				input.project_id,
				input.authorization.actor_id,
				input.operation,
				input.idempotency_key,
			],
		);
	return idempotencyResponse(row);
}

async function writeCurationIdempotency(
	client: Pick<PoolClient, "query">,
	input: {
		project_id: string;
		authorization: ProjectAuthorization;
		operation: DatasetCurationOperation;
		idempotency_key: string;
		dataset_id: string;
		request_hash: string;
		response: DatasetCurationReplay;
	},
): Promise<void> {
	await client.query(
		"INSERT INTO dataset_curation_idempotency (project_id, dataset_id, actor_id, operation, idempotency_key, request_hash, response) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
		[
			input.project_id,
			input.dataset_id,
			input.authorization.actor_id,
			input.operation,
			input.idempotency_key,
			input.request_hash,
			JSON.stringify(input.response),
		],
	);
}

export async function getDatasetCurationReplay(
	db: Transactional,
	input: {
		project_id: string;
		slug?: string;
		dataset_id?: string;
		operation: DatasetCurationOperation;
		idempotency_key: string;
		idempotency_request: Record<string, unknown>;
		legacy_idempotency_requests?: Record<string, unknown>[];
		authorization: ProjectAuthorization;
	},
): Promise<DatasetCurationReplay | null> {
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
		const dataset_id = input.dataset_id
			? await lockCurationDatasetById(
					client,
					input.project_id,
					input.dataset_id,
				)
			: input.slug
				? await lockCurationDataset(client, input.project_id, input.slug)
				: (() => {
						throw new DatasetRepositoryError(
							"BAD_REQUEST",
							"Dataset target is required",
						);
					})();
		const hashes = curationRequestHashes(dataset_id, input.idempotency_request);
		const replay = await readCurationIdempotency(client, {
			...input,
			dataset_id,
			request_hash: hashes.request_hash,
			legacy_request_hashes: [
				hashes.legacy_request_hash,
				...(input.legacy_idempotency_requests ?? []).map(
					(legacyRequest) =>
						curationRequestHashes(dataset_id, legacyRequest)
							.legacy_request_hash,
				),
			],
		});
		await client.query("COMMIT");
		return replay;
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function importDatasetDraftItems(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		revision?: number;
		items: DraftItemWriteInput[];
		idempotency_items?: DraftItemWriteInput[];
		idempotency_key: string;
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
		const dataset_id = await lockCurationDataset(
			client,
			input.project_id,
			input.slug,
		);
		const idempotency_request = {
			revision: input.revision,
			items: input.idempotency_items ?? input.items,
		};
		const { request_hash, legacy_request_hash } = curationRequestHashes(
			dataset_id,
			idempotency_request,
		);
		const replay = await readCurationIdempotency(client, {
			...input,
			operation: "import",
			dataset_id,
			request_hash,
			legacy_request_hashes: [legacy_request_hash],
		});
		if (replay) {
			await client.query("COMMIT");
			return { items: [], revision: replay.revision, idempotent: true };
		}
		const itemKeys = new Set<string>();
		const duplicateItemKeyErrors = input.items.flatMap((item, index) => {
			if (!itemKeys.has(item.item_key)) {
				itemKeys.add(item.item_key);
				return [];
			}
			return [
				{
					item_id: null,
					item_key: item.item_key,
					field: `items/${index}/item_key`,
					code: "DUPLICATE_ITEM_KEY",
					message: "Each import item_key must be unique",
				},
			];
		});
		const validationErrors = [
			...duplicateItemKeyErrors,
			...input.items.flatMap((item, index) =>
				validateDatasetDraftItem(item).map((issue) => ({
					item_id: null,
					item_key: item.item_key,
					field: `items/${index}/${issue.field}`,
					code: issue.code,
					message: issue.message,
				})),
			),
		];
		if (validationErrors.length)
			throw persistedValidationFailure(validationErrors);
		const draftRow = await curationDraft(client, input);
		const items = [];
		for (const item of input.items)
			items.push(
				await writeDraftItem(client, draftRow, item, input.authorization, {
					capture: item.capture ?? false,
					action: "imported",
				}),
			);
		const revision = await incrementDraftRevision(client, text(draftRow, "id"));
		await recordDraftAudit(client, {
			project_id: input.project_id,
			slug: input.slug,
			dataset_id: text(draftRow, "dataset_id"),
			authorization: input.authorization,
			event_type: "draft_items_imported",
			revision,
		});
		await writeCurationIdempotency(client, {
			...input,
			operation: "import",
			dataset_id,
			request_hash,
			response: {
				draft_id: text(draftRow, "id"),
				revision,
				item_ids: items.map((item) => item.id),
			},
		});
		await client.query("COMMIT");
		return { items, revision, idempotent: false };
	} catch (cause) {
		await client.query("ROLLBACK");
		throw normalizeError(cause);
	} finally {
		client.release();
	}
}

export async function captureDatasetDraftItemInTransaction(
	client: Pick<PoolClient, "query">,
	input: DraftItemWriteInput & {
		project_id: string;
		slug: string;
		revision?: number;
		idempotency_key: string;
		idempotency_operation?: "capture" | "feedback_promotion";
		idempotency_request?: unknown;
		authorization: ProjectAuthorization;
	},
) {
	if (
		!(await lockActiveAuthorizedProject(
			client,
			input.project_id,
			input.authorization,
		))
	)
		throw new DatasetRepositoryError("NOT_FOUND", "Project is not available");
	const operation = input.idempotency_operation ?? "capture";
	const dataset_id = await lockCurationDataset(
		client,
		input.project_id,
		input.slug,
	);
	const idempotency_request = input.idempotency_request ?? {
		revision: input.revision,
		item_key: input.item_key,
		external_id: input.external_id ?? null,
		source_trace_id: input.source_trace_id ?? null,
		source_observation_id: input.source_observation_id ?? null,
	};
	const { request_hash, legacy_request_hash } = curationRequestHashes(
		dataset_id,
		idempotency_request,
	);
	const replay = await readCurationIdempotency(client, {
		...input,
		operation,
		dataset_id,
		request_hash,
		legacy_request_hashes: [legacy_request_hash],
	});
	if (replay)
		return {
			item: null,
			item_id: replay.item_ids[0] ?? null,
			revision: replay.revision,
			idempotent: true,
			draft_id: replay.draft_id,
		};
	const draftRow = await curationDraft(
		client,
		input,
		operation === "feedback_promotion",
	);
	const item = await writeDraftItem(
		client,
		draftRow,
		input,
		input.authorization,
		{
			capture: true,
			action: "captured",
		},
	);
	const revision = await incrementDraftRevision(client, text(draftRow, "id"));
	await recordDraftAudit(client, {
		project_id: input.project_id,
		slug: input.slug,
		dataset_id: text(draftRow, "dataset_id"),
		authorization: input.authorization,
		event_type: "draft_item_captured",
		revision,
	});
	await writeCurationIdempotency(client, {
		...input,
		operation,
		dataset_id,
		request_hash,
		response: {
			draft_id: text(draftRow, "id"),
			revision,
			item_ids: [item.id],
		},
	});
	return {
		item,
		item_id: item.id,
		revision,
		idempotent: false,
		draft_id: text(draftRow, "id"),
	};
}

export async function captureDatasetDraftItem(
	db: Transactional,
	input: Parameters<typeof captureDatasetDraftItemInTransaction>[1],
) {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		const result = await captureDatasetDraftItemInTransaction(client, input);
		await client.query("COMMIT");
		return result;
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
		const linked = await client.query(
			"SELECT 1 FROM feedback_reviews WHERE dataset_draft_item_id = $1 FOR KEY SHARE",
			[input.item_key],
		);
		if (linked.rows[0])
			throw new DatasetRepositoryError(
				"CONFLICT",
				"Promoted feedback items cannot be deleted individually; discard the draft instead",
			);
		const removed = await client.query(
			"DELETE FROM dataset_draft_items WHERE draft_id = $1 AND id = $2::uuid RETURNING id",
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
		await client.query(
			`UPDATE feedback_reviews review SET status = 'reviewed', dataset_id = NULL, dataset_item_id = NULL, dataset_draft_item_id = NULL, updated_at = now() WHERE review.dataset_draft_item_id IN (SELECT item.id FROM dataset_draft_items item JOIN dataset_drafts draft ON draft.id = item.draft_id JOIN datasets dataset ON dataset.id = draft.dataset_id AND dataset.project_id = draft.project_id WHERE dataset.project_id = $1 AND dataset.slug = $2 AND dataset.archived_at IS NULL)`,
			[input.project_id, input.slug],
		);
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
		const draftItems = await client.query(
			"SELECT * FROM dataset_draft_items WHERE draft_id = $1 ORDER BY position, item_key FOR KEY SHARE",
			[row.id],
		);
		const validationErrors = validatePersistedDraftItems(
			draftItems.rows as Row[],
			true,
		);
		if (validationErrors.length)
			throw persistedValidationFailure(validationErrors);
		const version = Number(row.latest_published_version ?? 0) + 1;
		const snapshot = await client.query(
			`WITH inserted AS (INSERT INTO dataset_versions (project_id, dataset_id, version, item_count, content_hash, created_via, published_by, published_draft_revision) SELECT $1, $2, $3, COUNT(*)::int, encode(digest(jsonb_build_object('schema', $4::jsonb, 'items', COALESCE(jsonb_agg(jsonb_build_object('item_key', item_key, 'validation_version', validation_version, 'state', state, 'input', input, 'expected_output', expected_output, 'metadata', metadata, 'external_id', external_id, 'source_trace_id', source_trace_id, 'source_observation_id', source_observation_id, 'feedback_score_id', feedback_score_id, 'capture_context', capture_context, 'created_by', created_by, 'reviewed_by', reviewed_by, 'reviewed_at', reviewed_at) ORDER BY position, item_key), '[]'::jsonb))::text, 'sha256'), 'hex'), 'draft_publish', $6::uuid, $7 FROM dataset_draft_items WHERE draft_id = $5 RETURNING id), copied AS (INSERT INTO dataset_version_items (project_id, dataset_version_id, item_key, position, validation_version, state, input, expected_output, metadata, external_id, source_trace_id, source_observation_id, feedback_score_id, capture_context, curated_by, reviewed_by, reviewed_at) SELECT $1, inserted.id, i.item_key, i.position, i.validation_version, i.state, i.input, i.expected_output, i.metadata, i.external_id, i.source_trace_id, i.source_observation_id, i.feedback_score_id, i.capture_context, i.created_by, i.reviewed_by, i.reviewed_at FROM inserted JOIN dataset_draft_items i ON i.draft_id = $5 RETURNING id, item_key), linked_revisions AS (UPDATE dataset_draft_item_revisions revision SET dataset_version_item_id = copied.id FROM copied JOIN dataset_draft_items item ON item.project_id = $1 AND item.draft_id = $5 AND item.item_key = copied.item_key WHERE revision.project_id = $1 AND revision.dataset_id = $2 AND revision.draft_item_id = item.id RETURNING revision.id) UPDATE datasets SET latest_published_version = $3, updated_at = now() WHERE id = $2 RETURNING (SELECT id FROM inserted) AS version_id, (SELECT COUNT(*)::int FROM copied) AS item_count`,
			[
				input.project_id,
				row.dataset_id,
				version,
				JSON.stringify(row.schema ?? {}),
				row.id,
				input.authorization.actor_id,
				input.revision,
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
			`WITH selected_draft AS (SELECT dr.id FROM dataset_drafts dr WHERE dr.dataset_id = $1), visible_items AS (SELECT i.id::text AS id, i.item_key, $1::uuid AS dataset_id, i.validation_version, i.state, i.input, i.expected_output, i.metadata, i.external_id, i.source_trace_id, i.source_observation_id, i.feedback_score_id, i.capture_context, i.created_by, i.updated_by, i.reviewed_by, i.reviewed_at, i.created_at, i.position FROM dataset_draft_items i JOIN selected_draft d ON d.id = i.draft_id UNION ALL SELECT i.id::text, i.item_key, $1::uuid, i.validation_version, i.state, i.input, i.expected_output, i.metadata, i.external_id, i.source_trace_id, i.source_observation_id, i.feedback_score_id, i.capture_context, i.curated_by, NULL::uuid, i.reviewed_by, i.reviewed_at, i.created_at, i.position FROM dataset_version_items i JOIN dataset_versions v ON v.id = i.dataset_version_id JOIN datasets d ON d.id = v.dataset_id AND v.version = d.latest_published_version WHERE d.id = $1 AND NOT EXISTS (SELECT 1 FROM selected_draft)) SELECT i.id, i.item_key, i.dataset_id, i.validation_version, i.state, i.input, i.expected_output, i.metadata, i.external_id, i.source_trace_id, i.source_observation_id, i.feedback_score_id, i.capture_context, i.created_by, i.updated_by, i.reviewed_by, i.reviewed_at, i.created_at FROM visible_items i JOIN datasets d ON d.id = i.dataset_id JOIN projects p ON p.id = d.project_id AND p.status = 'active' WHERE d.project_id = $2 ORDER BY i.position ASC, i.created_at ASC, i.id ASC`,
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
			`SELECT i.id::text AS id, i.item_key, $1::uuid AS dataset_id, i.validation_version, i.state, i.input, i.expected_output, i.metadata, i.external_id, i.source_trace_id, i.source_observation_id, i.feedback_score_id, i.capture_context, i.curated_by AS created_by, NULL::uuid AS updated_by, i.reviewed_by, i.reviewed_at, i.created_at FROM dataset_version_items i JOIN dataset_versions v ON v.id = i.dataset_version_id JOIN datasets d ON d.id = v.dataset_id AND v.version = d.latest_published_version JOIN projects p ON p.id = d.project_id AND p.status = 'active' WHERE d.id = $1 AND d.project_id = $2 ORDER BY i.position ASC, i.created_at ASC, i.id ASC`,
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
