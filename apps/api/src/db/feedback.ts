import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	lockActiveAuthorizedProject,
	lockProjectAuditProvenance,
	type ProjectAuthorization,
} from "./project-authorization.js";

type Row = Record<string, unknown>;
export class FeedbackRepositoryError extends Error {
	readonly status: 400 | 404 | 409 | 500;
	constructor(
		readonly code:
			| "BAD_REQUEST"
			| "TARGET_NOT_FOUND"
			| "NOT_FOUND"
			| "IDEMPOTENCY_CONFLICT"
			| "CONFLICT"
			| "INTERNAL",
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "FeedbackRepositoryError";
		this.status =
			code === "BAD_REQUEST"
				? 400
				: code === "TARGET_NOT_FOUND" || code === "NOT_FOUND"
					? 404
					: code === "IDEMPOTENCY_CONFLICT" || code === "CONFLICT"
						? 409
						: 500;
	}
}
function text(row: Row, key: string): string {
	if (typeof row[key] !== "string")
		throw new FeedbackRepositoryError("INTERNAL", `Invalid feedback ${key}`);
	return row[key] as string;
}
function nullableText(row: Row, key: string): string | null {
	return row[key] == null ? null : text(row, key);
}
function time(row: Row, key: string): string {
	return row[key] instanceof Date
		? (row[key] as Date).toISOString()
		: text(row, key);
}
function metadata(row: Row): Record<string, unknown> {
	const value =
		typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function present(row: Row) {
	const feedback = metadata(row).feedback as
		| Record<string, unknown>
		| undefined;
	return {
		id: text(row, "id"),
		project_id: text(row, "project_id"),
		trace_id: text(row, "trace_id"),
		observation_id: nullableText(row, "observation_id"),
		target_type: (row.observation_id ? "observation" : "trace") as
			| "observation"
			| "trace",
		value: Number(row.value) as 1 | -1,
		sentiment: feedback?.sentiment as "positive" | "negative",
		reason: typeof feedback?.reason === "string" ? feedback.reason : null,
		comment: typeof feedback?.comment === "string" ? feedback.comment : null,
		status: text(row, "status") as
			| "new"
			| "reviewed"
			| "dismissed"
			| "added_to_dataset",
		note: nullableText(row, "note"),
		dataset_id: nullableText(row, "dataset_id"),
		dataset_item_id: nullableText(row, "dataset_item_id"),
		dataset_draft_item_id: nullableText(row, "dataset_draft_item_id"),
		created_at: time(row, "created_at"),
		updated_at: time(row, "updated_at"),
	};
}
const SELECT = `SELECT s.id, s.project_id, s.trace_id, s.observation_id, s.value, s.metadata, s.created_at, r.status, r.note, r.dataset_id, r.dataset_item_id, r.dataset_draft_item_id, r.updated_at FROM scores s JOIN projects p ON p.id=s.project_id AND p.status='active' JOIN feedback_reviews r ON r.score_id=s.id`;
async function requireActiveProject(
	client: PoolClient,
	projectId: string,
	authorization: ProjectAuthorization,
) {
	if (!(await lockActiveAuthorizedProject(client, projectId, authorization)))
		throw new FeedbackRepositoryError("NOT_FOUND", "Project is not available");
}
function normalized(input: {
	trace_id: string;
	observation_id?: string;
	value: 1 | -1;
	metadata: {
		feedback: {
			schema_version: 1;
			sentiment: "positive" | "negative";
			reason?: string;
			comment?: string;
		};
	};
}) {
	return JSON.stringify({
		trace_id: input.trace_id,
		observation_id: input.observation_id ?? null,
		value: input.value,
		feedback: input.metadata.feedback,
	});
}
export function requestHash(input: Parameters<typeof normalized>[0]) {
	return createHash("sha256").update(normalized(input)).digest("hex");
}
export async function createFeedback(
	db: Pool,
	input: Parameters<typeof normalized>[0] & {
		project_id: string;
		idempotency_key: string;
		authorization: ProjectAuthorization;
	},
) {
	const hash = requestHash(input);
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		await requireActiveProject(client, input.project_id, input.authorization);
		const existing = await client.query(
			`${SELECT} WHERE s.project_id=$1 AND s.id=(SELECT score_id FROM feedback_idempotency WHERE project_id=$1 AND idempotency_key=$2)`,
			[input.project_id, input.idempotency_key],
		);
		if (existing.rows[0]) {
			const key = await client.query(
				"SELECT request_hash FROM feedback_idempotency WHERE project_id=$1 AND idempotency_key=$2",
				[input.project_id, input.idempotency_key],
			);
			if (key.rows[0]?.request_hash !== hash)
				throw new FeedbackRepositoryError(
					"IDEMPOTENCY_CONFLICT",
					"Idempotency key was already used with a different request",
				);
			await client.query("COMMIT");
			return present(existing.rows[0]);
		}
		const id = randomUUID();
		const feedback = input.metadata.feedback;
		await client.query(
			`INSERT INTO scores (id, project_id, trace_id, observation_id, name, value, metadata) VALUES ($1,$2,$3,$4,'human.feedback',$5,$6::jsonb) RETURNING *`,
			[
				id,
				input.project_id,
				input.trace_id,
				input.observation_id ?? null,
				input.value,
				JSON.stringify({ feedback }),
			],
		);
		await client.query(
			`INSERT INTO feedback_reviews (score_id, project_id, status) VALUES ($1,$2,$3)`,
			[id, input.project_id, input.value === -1 ? "new" : "reviewed"],
		);
		await client.query(
			`INSERT INTO feedback_idempotency (project_id,idempotency_key,request_hash,score_id) VALUES ($1,$2,$3,$4)`,
			[input.project_id, input.idempotency_key, hash, id],
		);
		const result = await client.query(`${SELECT} WHERE s.id=$1`, [id]);
		await client.query("COMMIT");
		return present(result.rows[0]!);
	} catch (cause) {
		await client.query("ROLLBACK");
		if (cause instanceof FeedbackRepositoryError) throw cause;
		if ((cause as { code?: string }).code === "23505")
			return createFeedback(db, input);
		throw new FeedbackRepositoryError(
			"INTERNAL",
			"Feedback operation failed",
			cause,
		);
	} finally {
		client.release();
	}
}
export async function authorizeFeedbackProject(
	db: Pick<Pool, "connect">,
	input: { project_id: string; authorization: ProjectAuthorization },
) {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		await requireActiveProject(client, input.project_id, input.authorization);
		await client.query("COMMIT");
	} catch (cause) {
		await client.query("ROLLBACK");
		if (cause instanceof FeedbackRepositoryError) throw cause;
		throw new FeedbackRepositoryError(
			"INTERNAL",
			"Feedback operation failed",
			cause,
		);
	} finally {
		client.release();
	}
}
export async function listFeedback(
	db: Pick<Pool, "connect">,
	input: {
		project_id: string;
		sentiment?: string;
		status?: string;
		trace_id?: string;
		observation_id?: string;
		target_type?: string;
		limit: number;
		offset: number;
		authorization: ProjectAuthorization;
	},
) {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		await requireActiveProject(client, input.project_id, input.authorization);
		const clauses = ["s.project_id=$1", "s.name='human.feedback'"];
		const values: unknown[] = [input.project_id];
		const add = (sql: string, value: unknown) => {
			values.push(value);
			clauses.push(sql.replace("?", `$${values.length}`));
		};
		if (input.sentiment)
			add("s.metadata->'feedback'->>'sentiment'=?", input.sentiment);
		if (input.status) add("r.status=?", input.status);
		if (input.trace_id) add("s.trace_id=?", input.trace_id);
		if (input.observation_id) add("s.observation_id=?", input.observation_id);
		if (input.target_type)
			clauses.push(
				input.target_type === "observation"
					? "s.observation_id IS NOT NULL"
					: "s.observation_id IS NULL",
			);
		values.push(input.limit, input.offset);
		const where = clauses.join(" AND ");
		const rows = await client.query(
			`${SELECT} WHERE ${where} ORDER BY s.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
			values,
		);
		const total = await client.query(
			`SELECT COUNT(*)::int AS total FROM scores s JOIN projects p ON p.id=s.project_id AND p.status='active' JOIN feedback_reviews r ON r.score_id=s.id WHERE ${where}`,
			values.slice(0, -2),
		);
		await client.query("COMMIT");
		return {
			items: rows.rows.map(present),
			total: Number(total.rows[0]?.total ?? 0),
		};
	} catch (cause) {
		await client.query("ROLLBACK");
		if (cause instanceof FeedbackRepositoryError) throw cause;
		throw new FeedbackRepositoryError(
			"INTERNAL",
			"Feedback operation failed",
			cause,
		);
	} finally {
		client.release();
	}
}
export async function promoteFeedback(
	db: Pick<Pool, "connect">,
	input: {
		project_id: string;
		id: string;
		dataset_id: string;
		input: Record<string, unknown>;
		expected_output?: Record<string, unknown> | null;
		metadata?: Record<string, unknown>;
		authorization: ProjectAuthorization;
	},
) {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		await requireActiveProject(client, input.project_id, input.authorization);
		const existing = await client.query(
			`${SELECT} WHERE s.id=$1 AND s.project_id=$2 AND s.name='human.feedback' FOR UPDATE`,
			[input.id, input.project_id],
		);
		if (!existing.rows[0])
			throw new FeedbackRepositoryError("NOT_FOUND", "Feedback not found");
		const current = present(existing.rows[0]);
		if (current.status === "added_to_dataset") {
			if (current.dataset_id !== input.dataset_id)
				throw new FeedbackRepositoryError(
					"CONFLICT",
					"Added feedback is terminal",
				);
			await client.query("COMMIT");
			return current;
		}
		if (current.status !== "reviewed")
			throw new FeedbackRepositoryError(
				"CONFLICT",
				"Feedback must be reviewed before promotion",
			);
		const dataset = await client.query(
			"SELECT id, slug FROM datasets WHERE id=$1 AND project_id=$2 AND archived_at IS NULL FOR UPDATE",
			[input.dataset_id, input.project_id],
		);
		if (!dataset.rows[0])
			throw new FeedbackRepositoryError("NOT_FOUND", "Dataset not found");
		const draft = await client.query(
			`WITH inserted AS (INSERT INTO dataset_drafts (project_id, dataset_id, base_version, created_by) SELECT $1, id, latest_published_version, $3 FROM datasets WHERE id = $2 AND project_id = $1 ON CONFLICT (dataset_id) DO NOTHING RETURNING *), copied AS (INSERT INTO dataset_draft_items (project_id, draft_id, item_key, position, input, expected_output, metadata, source_trace_id, source_observation_id) SELECT d.project_id, d.id, i.item_key, i.position, i.input, i.expected_output, i.metadata, i.source_trace_id, i.source_observation_id FROM inserted d JOIN dataset_versions v ON v.project_id = d.project_id AND v.dataset_id = d.dataset_id AND v.version = d.base_version JOIN dataset_version_items i ON i.project_id = v.project_id AND i.dataset_version_id = v.id) SELECT *, EXISTS (SELECT 1 FROM inserted) AS created FROM inserted UNION ALL SELECT d.*, false FROM dataset_drafts d WHERE d.dataset_id = $2 AND NOT EXISTS (SELECT 1 FROM inserted) LIMIT 1`,
			[input.project_id, input.dataset_id, input.authorization.actor_id],
		);
		const draftRow = draft.rows[0];
		if (!draftRow)
			throw new FeedbackRepositoryError("NOT_FOUND", "Dataset draft not found");
		if (draftRow.created) {
			await lockProjectAuditProvenance(client, input.project_id);
			await client.query(
				"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type, draft_revision, item_count) VALUES ($1, $2, $3, $4, $5, 'draft_created', $6, $7)",
				[
					input.authorization.organization_id,
					input.project_id,
					input.dataset_id,
					dataset.rows[0].slug,
					input.authorization.actor_id,
					draftRow.revision,
					0,
				],
			);
		}
		const inserted = await client.query(
			`INSERT INTO dataset_draft_items (project_id, draft_id, item_key, position, input, expected_output, metadata, source_trace_id, source_observation_id, feedback_score_id) VALUES ($1,$2,$3,COALESCE((SELECT MAX(position) + 1 FROM dataset_draft_items WHERE draft_id=$2),0),$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$3::uuid) ON CONFLICT (feedback_score_id) WHERE feedback_score_id IS NOT NULL DO NOTHING RETURNING id`,
			[
				input.project_id,
				draftRow.id,
				current.id,
				JSON.stringify(input.input),
				input.expected_output == null
					? null
					: JSON.stringify(input.expected_output),
				JSON.stringify(input.metadata ?? {}),
				current.trace_id,
				current.observation_id,
				current.id,
			],
		);
		const itemId = inserted.rows[0]?.id as string | undefined;
		if (!itemId)
			throw new FeedbackRepositoryError(
				"CONFLICT",
				"Feedback is already being promoted",
			);
		await client.query(
			"UPDATE dataset_drafts SET revision = revision + 1, updated_at = now() WHERE id = $1",
			[draftRow.id],
		);
		await lockProjectAuditProvenance(client, input.project_id);
		await client.query(
			"INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type, draft_revision) VALUES ($1, $2, $3, $4, $5, 'draft_item_upserted', $6)",
			[
				input.authorization.organization_id,
				input.project_id,
				input.dataset_id,
				dataset.rows[0].slug,
				input.authorization.actor_id,
				Number(draftRow.revision) + 1,
			],
		);
		const result = await client.query(
			"UPDATE feedback_reviews SET status='added_to_dataset',dataset_id=$1,dataset_item_id=NULL,dataset_draft_item_id=$2,updated_at=now() WHERE score_id=$3 RETURNING updated_at",
			[input.dataset_id, itemId, current.id],
		);
		await client.query("COMMIT");
		return {
			...current,
			status: "added_to_dataset" as const,
			dataset_id: input.dataset_id,
			dataset_item_id: null,
			dataset_draft_item_id: itemId,
			updated_at: time(result.rows[0]!, "updated_at"),
		};
	} catch (cause) {
		await client.query("ROLLBACK");
		if (cause instanceof FeedbackRepositoryError) throw cause;
		throw new FeedbackRepositoryError(
			"INTERNAL",
			"Feedback operation failed",
			cause,
		);
	} finally {
		client.release();
	}
}
export async function reviewFeedback(
	db: Pick<Pool, "connect">,
	input: {
		project_id: string;
		id: string;
		status: "new" | "reviewed" | "dismissed" | "added_to_dataset";
		note?: string;
		dataset_id?: string;
		dataset_item_id?: string;
		authorization: ProjectAuthorization;
	},
) {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		await requireActiveProject(client, input.project_id, input.authorization);
		const existing = await client.query(
			`${SELECT} WHERE s.id=$1 AND s.project_id=$2 AND s.name='human.feedback' FOR UPDATE`,
			[input.id, input.project_id],
		);
		if (!existing.rows[0])
			throw new FeedbackRepositoryError("NOT_FOUND", "Feedback not found");
		const current = present(existing.rows[0]);
		if (current.status === "added_to_dataset") {
			if (
				input.status === "added_to_dataset" &&
				input.dataset_id === current.dataset_id &&
				input.dataset_item_id === current.dataset_item_id
			) {
				await client.query("COMMIT");
				return current;
			}
			throw new FeedbackRepositoryError(
				"CONFLICT",
				"Added feedback is terminal",
			);
		}
		if (current.value === 1 && input.status === "new")
			throw new FeedbackRepositoryError(
				"CONFLICT",
				"Positive feedback cannot enter the review queue",
			);
		if (input.status === "added_to_dataset") {
			if (current.status !== "reviewed")
				throw new FeedbackRepositoryError(
					"CONFLICT",
					"Feedback must be reviewed before promotion",
				);
			throw new FeedbackRepositoryError(
				"CONFLICT",
				"Use the feedback promotion endpoint to add feedback through a dataset draft",
			);
		}
		const result = await client.query(
			`UPDATE feedback_reviews SET status=$1,note=$2,dataset_id=$3,dataset_item_id=$4,updated_at=now() WHERE score_id=$5 RETURNING updated_at`,
			[input.status, input.note ?? null, null, null, input.id],
		);
		await client.query("COMMIT");
		return {
			...current,
			status: input.status,
			note: input.note ?? null,
			dataset_id: null,
			dataset_item_id: null,
			updated_at: time(result.rows[0]!, "updated_at"),
		};
	} catch (cause) {
		await client.query("ROLLBACK");
		if (cause instanceof FeedbackRepositoryError) throw cause;
		throw new FeedbackRepositoryError(
			"INTERNAL",
			"Feedback operation failed",
			cause,
		);
	} finally {
		client.release();
	}
}
