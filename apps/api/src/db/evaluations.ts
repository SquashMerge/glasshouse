import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { EvaluationDefinitionInput } from "../schemas/evaluations.js";
import {
	lockActiveAuthorizedProject,
	type ProjectAuthorization,
} from "./project-authorization.js";

type Transactional = Pick<Pool, "connect">;
type Row = Record<string, unknown>;
type Definition = {
	dataset_version_id: string;
	sampling: Row;
	evaluator: Row;
	target: Row;
	execution_defaults: Row;
	limits: Row;
	thresholds: Row;
};

export class EvaluationRepositoryError extends Error {
	readonly status: 400 | 404 | 409 | 500;
	constructor(
		readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "INTERNAL",
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "EvaluationRepositoryError";
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
function normalize(cause: unknown) {
	if (cause instanceof EvaluationRepositoryError) return cause;
	if (
		typeof cause === "object" &&
		cause !== null &&
		"code" in cause &&
		(cause.code === "23505" || cause.code === "55000")
	)
		return new EvaluationRepositoryError(
			"CONFLICT",
			"Evaluation definition changed or already exists",
			cause,
		);
	if (
		typeof cause === "object" &&
		cause !== null &&
		"code" in cause &&
		cause.code === "23503"
	)
		return new EvaluationRepositoryError(
			"NOT_FOUND",
			"Referenced Dataset Version not found",
			cause,
		);
	return new EvaluationRepositoryError(
		"INTERNAL",
		"Evaluation operation failed",
		cause,
	);
}
const text = (row: Row, key: string) => {
	if (typeof row[key] !== "string")
		throw new EvaluationRepositoryError("INTERNAL", `Invalid ${key}`);
	return row[key] as string;
};
const time = (row: Row, key: string) =>
	row[key] instanceof Date ? (row[key] as Date).toISOString() : text(row, key);
const object = (row: Row, key: string): Row => {
	const value =
		typeof row[key] === "string" ? JSON.parse(row[key] as string) : row[key];
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new EvaluationRepositoryError("INTERNAL", `Invalid ${key}`);
	return value as Row;
};
function evaluation(row: Row) {
	return {
		id: text(row, "id"),
		project_id: text(row, "project_id"),
		slug: text(row, "slug"),
		name: text(row, "name"),
		description: row.description == null ? null : text(row, "description"),
		lifecycle_revision: Number(row.lifecycle_revision ?? 1),
		archived_at: row.archived_at == null ? null : time(row, "archived_at"),
		tombstoned_at:
			row.tombstoned_at == null ? null : time(row, "tombstoned_at"),
		created_at: time(row, "created_at"),
		updated_at: time(row, "updated_at"),
	};
}
function definitionFields(row: Row) {
	const evaluator = object(row, "evaluator");
	return {
		dataset_version_id: text(row, "dataset_version_id"),
		sampling: object(row, "sampling"),
		evaluator,
		target: object(row, "target"),
		execution_defaults: object(row, "execution_defaults"),
		limits: object(row, "limits"),
		thresholds: object(row, "thresholds"),
	};
}
function definition(row: Row) {
	const fields = definitionFields(row);
	const parsed = EvaluationDefinitionInput.safeParse(fields);
	return {
		...fields,
		evaluation_id: text(row, "evaluation_id"),
		project_id: text(row, "project_id"),
		revision: Number(row.revision),
		updated_at: time(row, "updated_at"),
		definition_contract:
			parsed.success && canonical(parsed.data) === canonical(fields)
				? ("v1" as const)
				: ("legacy_incomplete" as const),
	};
}
function version(row: Row) {
	const sampling = row.sampling == null ? null : object(row, "sampling");
	const limits = row.limits == null ? null : object(row, "limits");
	const evaluator = object(row, "evaluator");
	return {
		id: text(row, "id"),
		evaluation_id: text(row, "evaluation_id"),
		project_id: text(row, "project_id"),
		dataset_version_id: text(row, "dataset_version_id"),
		definition_contract:
			sampling && limits && typeof evaluator.version === "string"
				? ("v1" as const)
				: ("legacy_untyped" as const),
		sampling,
		evaluator,
		target: object(row, "target"),
		execution_defaults: object(row, "execution_defaults"),
		limits,
		thresholds: object(row, "thresholds"),
		version: Number(row.version),
		content_hash: text(row, "content_hash"),
		published_draft_revision: Number(row.published_draft_revision),
		created_at: time(row, "created_at"),
	};
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Row)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function definitionHash(value: Definition) {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
async function transaction<T>(
	db: Transactional,
	callback: (client: PoolClient) => Promise<T>,
) {
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		const value = await callback(client);
		await client.query("COMMIT");
		return value;
	} catch (cause) {
		await client.query("ROLLBACK").catch(() => {});
		throw cause;
	} finally {
		client.release();
	}
}
async function authorize(
	client: PoolClient,
	projectId: string,
	authorization: ProjectAuthorization,
) {
	if (!(await lockActiveAuthorizedProject(client, projectId, authorization)))
		throw new EvaluationRepositoryError("NOT_FOUND", "Evaluation not found");
}

export async function createEvaluation(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		name: string;
		description?: string | null;
		definition: Definition;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(client, input.project_id, input.authorization);
			const inserted = await client.query(
				"INSERT INTO evaluations (id, organization_id, project_id, slug, name, description, created_by) SELECT $1, organization_id, id, $3, $4, $5, $6 FROM projects WHERE id=$2 RETURNING *",
				[
					randomUUID(),
					input.project_id,
					input.slug,
					input.name,
					input.description ?? null,
					input.authorization.actor_id,
				],
			);
			if (!inserted.rows[0])
				throw new EvaluationRepositoryError(
					"NOT_FOUND",
					"Evaluation not found",
				);
			const id = text(inserted.rows[0], "id");
			const draft = await client.query(
				"INSERT INTO evaluation_definition_drafts (evaluation_id, organization_id, project_id, dataset_version_id, sampling, evaluator, target, execution_defaults, limits, thresholds, updated_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11) RETURNING *",
				[
					id,
					input.authorization.organization_id,
					input.project_id,
					input.definition.dataset_version_id,
					JSON.stringify(input.definition.sampling),
					JSON.stringify(input.definition.evaluator),
					JSON.stringify(input.definition.target),
					JSON.stringify(input.definition.execution_defaults),
					JSON.stringify(input.definition.limits),
					JSON.stringify(input.definition.thresholds),
					input.authorization.actor_id,
				],
			);
			await client.query(
				"INSERT INTO evaluation_audit_events (organization_id, project_id, evaluation_id, actor_id, event_type) VALUES ($1,$2,$3,$4,'created')",
				[
					input.authorization.organization_id,
					input.project_id,
					id,
					input.authorization.actor_id,
				],
			);
			return {
				evaluation: evaluation(inserted.rows[0]),
				draft: definition(draft.rows[0] as Row),
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listEvaluations(
	db: Transactional,
	input: { project_id: string; authorization: ProjectAuthorization },
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(client, input.project_id, input.authorization);
			const r = await client.query(
				"SELECT * FROM evaluations WHERE project_id=$1 AND archived_at IS NULL ORDER BY created_at DESC",
				[input.project_id],
			);
			return {
				items: r.rows.map(evaluation),
				total: r.rowCount ?? r.rows.length,
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listEvaluationsIncludingArchived(
	db: Transactional,
	input: { project_id: string; authorization: ProjectAuthorization },
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(client, input.project_id, input.authorization);
			const r = await client.query(
				"SELECT * FROM evaluations WHERE project_id=$1 ORDER BY created_at DESC",
				[input.project_id],
			);
			return {
				items: r.rows.map(evaluation),
				total: r.rowCount ?? r.rows.length,
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function getEvaluation(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(client, input.project_id, input.authorization);
			const r = await client.query(
				"SELECT * FROM evaluations WHERE (slug=$1 OR id::text=$1) AND project_id=$2",
				[input.slug, input.project_id],
			);
			if (!r.rows[0])
				throw new EvaluationRepositoryError(
					"NOT_FOUND",
					"Evaluation not found",
				);
			return evaluation(r.rows[0]);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function getEvaluationDraft(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(client, input.project_id, input.authorization);
			const r = await client.query(
				"SELECT d.* FROM evaluation_definition_drafts d JOIN evaluations e ON e.id=d.evaluation_id AND e.project_id=d.project_id WHERE (e.slug=$1 OR e.id::text=$1) AND d.project_id=$2",
				[input.slug, input.project_id],
			);
			if (!r.rows[0])
				throw new EvaluationRepositoryError(
					"NOT_FOUND",
					"Evaluation draft not found",
				);
			return definition(r.rows[0]);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function updateEvaluationDraft(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		revision: number;
		definition: Definition;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(client, input.project_id, input.authorization);
			const active = " AND archived_at IS NULL";
			const r = await client.query(
				`UPDATE evaluation_definition_drafts SET dataset_version_id=$4, sampling=$5::jsonb, evaluator=$6::jsonb, target=$7::jsonb, execution_defaults=$8::jsonb, limits=$9::jsonb, thresholds=$10::jsonb, revision=revision+1, updated_by=$11, updated_at=now() WHERE evaluation_id=(SELECT id FROM evaluations WHERE (slug=$1 OR id::text=$1) AND project_id=$2${active}) AND project_id=$2 AND revision=$3 RETURNING *`,
				[
					input.slug,
					input.project_id,
					input.revision,
					input.definition.dataset_version_id,
					JSON.stringify(input.definition.sampling),
					JSON.stringify(input.definition.evaluator),
					JSON.stringify(input.definition.target),
					JSON.stringify(input.definition.execution_defaults),
					JSON.stringify(input.definition.limits),
					JSON.stringify(input.definition.thresholds),
					input.authorization.actor_id,
				],
			);
			if (!r.rows[0]) {
				const current = await client.query(
					"SELECT d.revision FROM evaluation_definition_drafts d JOIN evaluations e ON e.id=d.evaluation_id AND e.project_id=d.project_id WHERE (e.slug=$1 OR e.id::text=$1) AND d.project_id=$2",
					[input.slug, input.project_id],
				);
				if (current.rows[0])
					throw new EvaluationRepositoryError(
						"CONFLICT",
						`Evaluation draft is at revision ${current.rows[0].revision}`,
					);
				throw new EvaluationRepositoryError(
					"NOT_FOUND",
					"Evaluation draft not found",
				);
			}
			await client.query(
				"INSERT INTO evaluation_audit_events (organization_id, project_id, evaluation_id, actor_id, event_type) VALUES ($1,$2,$3,$4,'draft_updated')",
				[
					input.authorization.organization_id,
					input.project_id,
					text(r.rows[0] as Row, "evaluation_id"),
					input.authorization.actor_id,
				],
			);
			return definition(r.rows[0]);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function publishEvaluationDraft(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		revision: number;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(client, input.project_id, input.authorization);
			const draft = await client.query(
				"SELECT d.* FROM evaluation_definition_drafts d JOIN evaluations e ON e.id=d.evaluation_id AND e.project_id=d.project_id WHERE (e.slug=$1 OR e.id::text=$1) AND d.project_id=$2 AND e.archived_at IS NULL FOR UPDATE OF d",
				[input.slug, input.project_id],
			);
			if (!draft.rows[0])
				throw new EvaluationRepositoryError(
					"NOT_FOUND",
					"Evaluation draft not found",
				);
			const row = draft.rows[0] as Row;
			if (Number(row.revision) !== input.revision)
				throw new EvaluationRepositoryError(
					"CONFLICT",
					`Evaluation draft is at revision ${row.revision}`,
				);
			const value = {
				dataset_version_id: text(row, "dataset_version_id"),
				sampling: object(row, "sampling"),
				evaluator: object(row, "evaluator"),
				target: object(row, "target"),
				execution_defaults: object(row, "execution_defaults"),
				limits: object(row, "limits"),
				thresholds: object(row, "thresholds"),
			};
			const parsed = EvaluationDefinitionInput.safeParse(value);
			if (!parsed.success || canonical(parsed.data) !== canonical(value))
				throw new EvaluationRepositoryError(
					"BAD_REQUEST",
					"Evaluation draft must be replaced with a complete typed Definition before publishing",
				);
			const complete = parsed.data as Definition;
			const hash = definitionHash(complete);
			const existing = await client.query(
				"SELECT v.* FROM evaluation_definition_versions v WHERE v.evaluation_id=$1 AND v.content_hash=$2",
				[text(row, "evaluation_id"), hash],
			);
			if (existing.rows[0]) return version(existing.rows[0]);
			const inserted = await client.query(
				"INSERT INTO evaluation_definition_versions (id, evaluation_id, organization_id, project_id, version, dataset_version_id, sampling, evaluator, target, execution_defaults, limits, thresholds, content_hash, published_by, published_draft_revision) VALUES ($1,$2,$3,$4,(SELECT coalesce(max(version),0)+1 FROM evaluation_definition_versions WHERE evaluation_id=$2),$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14) RETURNING *",
				[
					randomUUID(),
					text(row, "evaluation_id"),
					input.authorization.organization_id,
					input.project_id,
					complete.dataset_version_id,
					JSON.stringify(complete.sampling),
					JSON.stringify(complete.evaluator),
					JSON.stringify(complete.target),
					JSON.stringify(complete.execution_defaults),
					JSON.stringify(complete.limits),
					JSON.stringify(complete.thresholds),
					hash,
					input.authorization.actor_id,
					input.revision,
				],
			);
			await client.query(
				"INSERT INTO evaluation_audit_events (organization_id, project_id, evaluation_id, actor_id, event_type, definition_version_id, content_hash) VALUES ($1,$2,$3,$4,'definition_published',$5,$6)",
				[
					input.authorization.organization_id,
					input.project_id,
					text(row, "evaluation_id"),
					input.authorization.actor_id,
					inserted.rows[0].id,
					hash,
				],
			);
			return version(inserted.rows[0]);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function transitionEvaluationLifecycle(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		revision: number;
		action: "archive" | "restore" | "tombstone";
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(client, input.project_id, input.authorization);
			const predicate =
				input.action === "archive"
					? "archived_at IS NULL"
					: input.action === "restore"
						? "archived_at IS NOT NULL AND tombstoned_at IS NULL"
						: "archived_at IS NOT NULL AND tombstoned_at IS NULL";
			const set =
				input.action === "archive"
					? "archived_at=now()"
					: input.action === "restore"
						? "archived_at=NULL"
						: "tombstoned_at=now()";
			const result = await client.query(
				`UPDATE evaluations SET ${set}, lifecycle_revision=lifecycle_revision+1, updated_at=now() WHERE (slug=$1 OR id::text=$1) AND project_id=$2 AND lifecycle_revision=$3 AND ${predicate} RETURNING *`,
				[input.slug, input.project_id, input.revision],
			);
			if (!result.rows[0])
				throw new EvaluationRepositoryError(
					"CONFLICT",
					"Evaluation lifecycle changed or cannot make that transition",
				);
			const row = result.rows[0] as Row;
			const eventType =
				input.action === "archive"
					? "archived"
					: input.action === "restore"
						? "restored"
						: "tombstoned";
			await client.query(
				"INSERT INTO evaluation_audit_events (organization_id, project_id, evaluation_id, actor_id, event_type) VALUES ($1,$2,$3,$4,$5)",
				[
					input.authorization.organization_id,
					input.project_id,
					text(row, "id"),
					input.authorization.actor_id,
					eventType,
				],
			);
			return evaluation(row);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listEvaluationVersions(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(client, input.project_id, input.authorization);
			const r = await client.query(
				"SELECT v.* FROM evaluation_definition_versions v JOIN evaluations e ON e.id=v.evaluation_id AND e.project_id=v.project_id WHERE (e.slug=$1 OR e.id::text=$1) AND v.project_id=$2 ORDER BY v.version DESC",
				[input.slug, input.project_id],
			);
			return { items: r.rows.map(version) };
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function getEvaluationVersion(
	db: Transactional,
	input: {
		project_id: string;
		slug: string;
		version: number;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(client, input.project_id, input.authorization);
			const r = await client.query(
				"SELECT v.* FROM evaluation_definition_versions v JOIN evaluations e ON e.id=v.evaluation_id AND e.project_id=v.project_id WHERE (e.slug=$1 OR e.id::text=$1) AND v.project_id=$2 AND v.version=$3",
				[input.slug, input.project_id, input.version],
			);
			if (!r.rows[0])
				throw new EvaluationRepositoryError(
					"NOT_FOUND",
					"Evaluation definition version not found",
				);
			return version(r.rows[0]);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function listEvaluationLegacyLinks(
	db: Transactional,
	input: { project_id: string; authorization: ProjectAuthorization },
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(client, input.project_id, input.authorization);
			const r = await client.query(
				"SELECT legacy_kind, legacy_id, dataset_id, created_at FROM (SELECT legacy_kind, legacy_id, dataset_id, created_at FROM evaluation_legacy_links WHERE project_id=$1 UNION SELECT 'experiment'::text, id, dataset_id, created_at FROM experiments WHERE project_id=$1 UNION SELECT 'benchmark_suite'::text, id, dataset_id, created_at FROM benchmark_suites WHERE project_id=$1) links ORDER BY created_at DESC",
				[input.project_id],
			);
			return {
				items: r.rows.map((row: Row) => ({
					legacy_kind: text(row, "legacy_kind"),
					legacy_id: text(row, "legacy_id"),
					dataset_id: row.dataset_id == null ? null : text(row, "dataset_id"),
					compatibility: "legacy_ad_hoc" as const,
					created_at: time(row, "created_at"),
				})),
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
