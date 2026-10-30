import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	EvaluationEvaluator,
	EvaluationDefinitionInput,
} from "../schemas/evaluations.js";
import {
	admitEvaluationRun,
	EvaluationRunRepositoryError,
	type EvaluationRun,
	type EvaluationRunAdmissionInput,
} from "./evaluation-runs.js";
import {
	lockActiveAuthorizedProject,
	type ProjectAuthorization,
} from "./project-authorization.js";

type Transactional = Pick<Pool, "connect">;
type Row = Record<string, unknown>;
type GateContext = "ci" | "release";
type GateStatus =
	| "pending"
	| "passed"
	| "failed"
	| "inconclusive"
	| "error"
	| "cancelled";

export type EvaluationGateApproval = {
	id: string;
	organization_id: string;
	project_id: string;
	evaluation_id: string;
	definition_version_id: string;
	definition_version: number;
	definition_contract: "v1" | "legacy_incompatible";
	dataset_version_id: string;
	definition_content_hash: string;
	dataset_content_hash: string;
	gate_context: GateContext;
	minimum_pass_rate: number;
	reason: string;
	approved_by_actor_id: string;
	approved_at: string;
	revoked_at: string | null;
	revoked_by_actor_id: string | null;
	revocation_reason: string | null;
	superseded_by: string | null;
	status: "active" | "revoked" | "superseded";
	created_at: string;
};

export type EvaluationGateAuditEvent = {
	id: string;
	approval_id: string;
	gate_run_id: string | null;
	evaluation_run_id: string | null;
	definition_version_id: string;
	actor_id: string;
	event_type:
		| "approved"
		| "revoked"
		| "superseded"
		| "invoked"
		| "outcome_recorded";
	gate_context: GateContext | null;
	outcome_status: GateStatus | null;
	reason_digest: string | null;
	created_at: string;
};

export type EvaluationGateRun = {
	id: string;
	organization_id: string;
	project_id: string;
	approval_id: string;
	evaluation_run_id: string;
	evaluation_id: string;
	definition_version_id: string;
	dataset_version_id: string;
	definition_content_hash: string;
	dataset_content_hash: string;
	target_fingerprint: string;
	evaluator_fingerprint: string;
	gate_context: GateContext;
	minimum_pass_rate: number;
	selected_count: number | null;
	evaluated_count: number | null;
	passed_count: number | null;
	failed_count: number | null;
	status: GateStatus;
	outcome_reason: string | null;
	requested_by_actor_id: string;
	idempotency_key: string;
	created_at: string;
	updated_at: string;
};

export class EvaluationGateRepositoryError extends Error {
	readonly status: 400 | 403 | 404 | 409 | 429 | 500;
	constructor(
		readonly code:
			| "BAD_REQUEST"
			| "FORBIDDEN"
			| "NOT_FOUND"
			| "CONFLICT"
			| "TOO_MANY_REQUESTS"
			| "INTERNAL",
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "EvaluationGateRepositoryError";
		this.status =
			code === "BAD_REQUEST"
				? 400
				: code === "FORBIDDEN"
					? 403
					: code === "NOT_FOUND"
						? 404
						: code === "CONFLICT"
							? 409
							: code === "TOO_MANY_REQUESTS"
								? 429
								: 500;
	}
}

function normalize(cause: unknown): EvaluationGateRepositoryError {
	if (cause instanceof EvaluationGateRepositoryError) return cause;
	const code = (cause as { code?: unknown } | null)?.code;
	if (code === "23505" || code === "55000")
		return new EvaluationGateRepositoryError(
			"CONFLICT",
			"Evaluation Gate state changed or already exists",
			cause,
		);
	if (code === "23503")
		return new EvaluationGateRepositoryError(
			"NOT_FOUND",
			"Evaluation Gate resource is not available",
			cause,
		);
	return new EvaluationGateRepositoryError(
		"INTERNAL",
		"Evaluation Gate operation failed",
		cause,
	);
}

function text(row: Row, field: string): string {
	if (typeof row[field] !== "string" || row[field] === "")
		throw new EvaluationGateRepositoryError("INTERNAL", `Invalid ${field}`);
	return row[field] as string;
}
function nullableText(row: Row, field: string): string | null {
	return row[field] == null ? null : text(row, field);
}
function timestamp(row: Row, field: string): string {
	if (row[field] instanceof Date) return (row[field] as Date).toISOString();
	return text(row, field);
}
function numeric(row: Row, field: string): number {
	const value = Number(row[field]);
	if (!Number.isFinite(value))
		throw new EvaluationGateRepositoryError("INTERNAL", `Invalid ${field}`);
	return value;
}
function nullableNumeric(row: Row, field: string): number | null {
	return row[field] == null ? null : numeric(row, field);
}
function safeReason(reason: string): string {
	return reason
		.replace(
			/(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|private[_-]?key)\s*[:=]\s*\S+/gi,
			"$1=[REDACTED]",
		)
		.trim()
		.slice(0, 1000);
}
function reasonDigest(reason: string): string {
	return createHash("sha256").update(reason).digest("hex");
}
function approvalDefinitionContract(
	row: Row,
): EvaluationGateApproval["definition_contract"] {
	try {
		const raw = row.definition_evaluator;
		const evaluator = typeof raw === "string" ? JSON.parse(raw) : raw;
		return EvaluationEvaluator.safeParse(evaluator).success
			? "v1"
			: "legacy_incompatible";
	} catch {
		return "legacy_incompatible";
	}
}
function approval(row: Row): EvaluationGateApproval {
	const revokedAt =
		row.revoked_at == null ? null : timestamp(row, "revoked_at");
	const supersededBy = nullableText(row, "superseded_by");
	return {
		id: text(row, "id"),
		organization_id: text(row, "organization_id"),
		project_id: text(row, "project_id"),
		evaluation_id: text(row, "evaluation_id"),
		definition_version_id: text(row, "definition_version_id"),
		definition_version: numeric(row, "definition_version"),
		definition_contract: approvalDefinitionContract(row),
		dataset_version_id: text(row, "dataset_version_id"),
		definition_content_hash: text(row, "definition_content_hash"),
		dataset_content_hash: text(row, "dataset_content_hash"),
		gate_context: text(row, "gate_context") as GateContext,
		minimum_pass_rate: numeric(row, "minimum_pass_rate"),
		reason: text(row, "reason"),
		approved_by_actor_id: text(row, "approved_by_actor_id"),
		approved_at: timestamp(row, "approved_at"),
		revoked_at: revokedAt,
		revoked_by_actor_id: nullableText(row, "revoked_by_actor_id"),
		revocation_reason: nullableText(row, "revocation_reason"),
		superseded_by: supersededBy,
		status: revokedAt ? (supersededBy ? "superseded" : "revoked") : "active",
		created_at: timestamp(row, "created_at"),
	};
}
function gateRun(row: Row): EvaluationGateRun {
	return {
		id: text(row, "id"),
		organization_id: text(row, "organization_id"),
		project_id: text(row, "project_id"),
		approval_id: text(row, "approval_id"),
		evaluation_run_id: text(row, "evaluation_run_id"),
		evaluation_id: text(row, "evaluation_id"),
		definition_version_id: text(row, "definition_version_id"),
		dataset_version_id: text(row, "dataset_version_id"),
		definition_content_hash: text(row, "definition_content_hash"),
		dataset_content_hash: text(row, "dataset_content_hash"),
		target_fingerprint: text(row, "target_fingerprint"),
		evaluator_fingerprint: text(row, "evaluator_fingerprint"),
		gate_context: text(row, "gate_context") as GateContext,
		minimum_pass_rate: numeric(row, "minimum_pass_rate"),
		selected_count: nullableNumeric(row, "selected_count"),
		evaluated_count: nullableNumeric(row, "evaluated_count"),
		passed_count: nullableNumeric(row, "passed_count"),
		failed_count: nullableNumeric(row, "failed_count"),
		status: text(row, "status") as GateStatus,
		outcome_reason: nullableText(row, "outcome_reason"),
		requested_by_actor_id: text(row, "requested_by_actor_id"),
		idempotency_key: text(row, "idempotency_key"),
		created_at: timestamp(row, "created_at"),
		updated_at: timestamp(row, "updated_at"),
	};
}

function auditEvent(row: Row): EvaluationGateAuditEvent {
	return {
		id: text(row, "id"),
		approval_id: text(row, "approval_id"),
		gate_run_id: nullableText(row, "gate_run_id"),
		evaluation_run_id: nullableText(row, "evaluation_run_id"),
		definition_version_id: text(row, "definition_version_id"),
		actor_id: text(row, "actor_id"),
		event_type: text(
			row,
			"event_type",
		) as EvaluationGateAuditEvent["event_type"],
		gate_context: nullableText(row, "gate_context") as GateContext | null,
		outcome_status: nullableText(row, "outcome_status") as GateStatus | null,
		reason_digest: nullableText(row, "reason_digest"),
		created_at: timestamp(row, "created_at"),
	};
}

async function transaction<T>(
	db: Transactional,
	callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await db.connect();
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
async function authorize(
	client: PoolClient,
	projectId: string,
	authorization: ProjectAuthorization,
	operation: "product_read" | "release_gate_manage",
): Promise<void> {
	if (!(await lockActiveAuthorizedProject(client, projectId, authorization)))
		throw new EvaluationGateRepositoryError(
			operation === "release_gate_manage" ? "FORBIDDEN" : "NOT_FOUND",
			operation === "release_gate_manage"
				? "Administrator authorization is required for Evaluation Gates"
				: "Evaluation Gate is not available",
		);
}

const approvalLookup = `
SELECT approval.*, definition.version AS definition_version,
       definition.evaluator AS definition_evaluator
FROM evaluation_gate_approvals approval
JOIN evaluation_definition_versions definition
  ON definition.id = approval.definition_version_id
 AND definition.project_id = approval.project_id
WHERE approval.id = $1 AND approval.project_id = $2`;

export async function createEvaluationGateApproval(
	db: Transactional,
	input: {
		project_id: string;
		definition_version_id: string;
		gate_context: GateContext;
		reason: string;
		supersedes_approval_id?: string | null;
		authorization: ProjectAuthorization;
	},
): Promise<EvaluationGateApproval> {
	try {
		return await transaction(db, async (client) => {
			await authorize(
				client,
				input.project_id,
				input.authorization,
				"release_gate_manage",
			);
			const definitionResult = await client.query(
				`SELECT definition.*, dataset_version.content_hash AS dataset_content_hash,
				        evaluation.project_id AS evaluation_project_id
				 FROM evaluation_definition_versions definition
				 JOIN evaluations evaluation ON evaluation.id = definition.evaluation_id
				  AND evaluation.project_id = definition.project_id
				 JOIN dataset_versions dataset_version ON dataset_version.id = definition.dataset_version_id
				  AND dataset_version.project_id = definition.project_id
				 JOIN datasets dataset ON dataset.id = dataset_version.dataset_id
				  AND dataset.project_id = dataset_version.project_id
				 WHERE definition.id=$1 AND definition.project_id=$2
				   AND evaluation.archived_at IS NULL AND evaluation.tombstoned_at IS NULL
				   AND dataset.archived_at IS NULL
				 FOR UPDATE OF definition, evaluation, dataset_version, dataset`,
				[input.definition_version_id, input.project_id],
			);
			const row = definitionResult.rows[0] as Row | undefined;
			if (!row)
				throw new EvaluationGateRepositoryError(
					"NOT_FOUND",
					"Immutable Evaluation Definition Version is not available",
				);
			const sampling = row.sampling;
			const limits = row.limits;
			const definition = {
				dataset_version_id: text(row, "dataset_version_id"),
				sampling:
					typeof sampling === "string" ? JSON.parse(sampling) : sampling,
				evaluator:
					typeof row.evaluator === "string"
						? JSON.parse(row.evaluator)
						: row.evaluator,
				target:
					typeof row.target === "string" ? JSON.parse(row.target) : row.target,
				execution_defaults:
					typeof row.execution_defaults === "string"
						? JSON.parse(row.execution_defaults)
						: row.execution_defaults,
				limits: typeof limits === "string" ? JSON.parse(limits) : limits,
				thresholds:
					typeof row.thresholds === "string"
						? JSON.parse(row.thresholds)
						: row.thresholds,
			};
			const parsed = EvaluationDefinitionInput.safeParse(definition);
			if (
				!parsed.success ||
				parsed.data.thresholds.minimum_pass_rate === null ||
				!parsed.data.target.provider ||
				!parsed.data.target.model
			)
				throw new EvaluationGateRepositoryError(
					"BAD_REQUEST",
					"Only a complete typed Definition Version with a pinned minimum pass rate can be approved",
				);
			const reason = safeReason(input.reason);
			if (!reason)
				throw new EvaluationGateRepositoryError(
					"BAD_REQUEST",
					"Approval reason is required",
				);
			const approvalId = crypto.randomUUID();
			if (input.supersedes_approval_id) {
				const previous = await client.query(
					`${approvalLookup} AND approval.revoked_at IS NULL FOR UPDATE`,
					[input.supersedes_approval_id, input.project_id],
				);
				const previousRow = previous.rows[0] as Row | undefined;
				if (
					!previousRow ||
					text(previousRow, "definition_version_id") !==
						input.definition_version_id ||
					text(previousRow, "gate_context") !== input.gate_context
				)
					throw new EvaluationGateRepositoryError(
						"CONFLICT",
						"Only an active approval for the same immutable Definition Version and context can be superseded",
					);
				await client.query(
					"UPDATE evaluation_gate_approvals SET revoked_at=now(), revoked_by_actor_id=$3, revocation_reason='superseded', superseded_by=$4 WHERE id=$1 AND project_id=$2 AND revoked_at IS NULL",
					[
						input.supersedes_approval_id,
						input.project_id,
						input.authorization.actor_id,
						approvalId,
					],
				);
				await client.query(
					"INSERT INTO evaluation_gate_audit_events (organization_id, project_id, approval_id, definition_version_id, actor_id, event_type, gate_context, reason_digest) VALUES ($1,$2,$3,$4,$5,'superseded',$6,$7)",
					[
						input.authorization.organization_id,
						input.project_id,
						input.supersedes_approval_id,
						input.definition_version_id,
						input.authorization.actor_id,
						input.gate_context,
						reasonDigest(reason),
					],
				);
			}
			const inserted = await client.query(
				`INSERT INTO evaluation_gate_approvals (
					id, organization_id, project_id, evaluation_id, definition_version_id,
					dataset_version_id, definition_content_hash, dataset_content_hash,
					gate_context, minimum_pass_rate, reason, approved_by_actor_id
				) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
				[
					approvalId,
					input.authorization.organization_id,
					input.project_id,
					text(row, "evaluation_id"),
					input.definition_version_id,
					text(row, "dataset_version_id"),
					text(row, "content_hash"),
					text(row, "dataset_content_hash"),
					input.gate_context,
					parsed.data.thresholds.minimum_pass_rate,
					reason,
					input.authorization.actor_id,
				],
			);
			const insertedRow = inserted.rows[0] as Row;
			await client.query(
				"INSERT INTO evaluation_gate_audit_events (organization_id, project_id, approval_id, definition_version_id, actor_id, event_type, gate_context, reason_digest) VALUES ($1,$2,$3,$4,$5,'approved',$6,$7)",
				[
					input.authorization.organization_id,
					input.project_id,
					approvalId,
					input.definition_version_id,
					input.authorization.actor_id,
					input.gate_context,
					reasonDigest(reason),
				],
			);
			return approval({
				...insertedRow,
				definition_version: row.version,
				definition_evaluator: row.evaluator,
			});
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function listEvaluationGateApprovalHistory(
	db: Transactional,
	input: {
		approval_id: string;
		project_id: string;
		authorization: ProjectAuthorization;
	},
): Promise<{ items: EvaluationGateAuditEvent[] }> {
	try {
		return await transaction(db, async (client) => {
			await authorize(
				client,
				input.project_id,
				input.authorization,
				"product_read",
			);
			const result = await client.query(
				`SELECT id, approval_id, gate_run_id, evaluation_run_id,
				        definition_version_id, actor_id, event_type, gate_context,
				        outcome_status, reason_digest, created_at
				 FROM evaluation_gate_audit_events
				 WHERE approval_id=$1 AND project_id=$2
				 ORDER BY created_at ASC, id ASC`,
				[input.approval_id, input.project_id],
			);
			return { items: result.rows.map((row) => auditEvent(row as Row)) };
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function listEvaluationGateApprovals(
	db: Transactional,
	input: {
		project_id: string;
		include_revoked?: boolean;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(
				client,
				input.project_id,
				input.authorization,
				"product_read",
			);
			const result = await client.query(
				`SELECT approval.*, definition.version AS definition_version,
				        definition.evaluator AS definition_evaluator
				 FROM evaluation_gate_approvals approval
				 JOIN evaluation_definition_versions definition ON definition.id=approval.definition_version_id
				  AND definition.project_id=approval.project_id
				 WHERE approval.project_id=$1
				   AND ($2::boolean OR approval.revoked_at IS NULL)
				 ORDER BY approval.created_at DESC, approval.id DESC`,
				[input.project_id, input.include_revoked ?? false],
			);
			return {
				items: result.rows.map((row) => approval(row as Row)),
				total: result.rowCount ?? 0,
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function getEvaluationGateApproval(
	db: Transactional,
	input: {
		id: string;
		project_id: string;
		authorization: ProjectAuthorization;
	},
): Promise<EvaluationGateApproval> {
	try {
		return await transaction(db, async (client) => {
			await authorize(
				client,
				input.project_id,
				input.authorization,
				"product_read",
			);
			const result = await client.query(approvalLookup, [
				input.id,
				input.project_id,
			]);
			if (!result.rows[0])
				throw new EvaluationGateRepositoryError(
					"NOT_FOUND",
					"Evaluation Gate approval is not available",
				);
			return approval(result.rows[0] as Row);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function revokeEvaluationGateApproval(
	db: Transactional,
	input: {
		id: string;
		project_id: string;
		reason: string;
		authorization: ProjectAuthorization;
	},
): Promise<EvaluationGateApproval> {
	try {
		return await transaction(db, async (client) => {
			await authorize(
				client,
				input.project_id,
				input.authorization,
				"release_gate_manage",
			);
			const result = await client.query(`${approvalLookup} FOR UPDATE`, [
				input.id,
				input.project_id,
			]);
			const row = result.rows[0] as Row | undefined;
			if (!row)
				throw new EvaluationGateRepositoryError(
					"NOT_FOUND",
					"Evaluation Gate approval is not available",
				);
			if (row.revoked_at != null)
				throw new EvaluationGateRepositoryError(
					"CONFLICT",
					"Evaluation Gate approval is already revoked",
				);
			const reason = safeReason(input.reason);
			if (!reason)
				throw new EvaluationGateRepositoryError(
					"BAD_REQUEST",
					"Revocation reason is required",
				);
			await client.query(
				"UPDATE evaluation_gate_approvals SET revoked_at=now(), revoked_by_actor_id=$3, revocation_reason=$4 WHERE id=$1 AND project_id=$2 AND revoked_at IS NULL",
				[input.id, input.project_id, input.authorization.actor_id, reason],
			);
			await client.query(
				"INSERT INTO evaluation_gate_audit_events (organization_id, project_id, approval_id, definition_version_id, actor_id, event_type, gate_context, reason_digest) VALUES ($1,$2,$3,$4,$5,'revoked',$6,$7)",
				[
					input.authorization.organization_id,
					input.project_id,
					input.id,
					text(row, "definition_version_id"),
					input.authorization.actor_id,
					text(row, "gate_context"),
					reasonDigest(reason),
				],
			);
			const updated = await client.query(approvalLookup, [
				input.id,
				input.project_id,
			]);
			return approval(updated.rows[0] as Row);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

const gateRunLookup = `SELECT * FROM evaluation_gate_runs WHERE id=$1 AND project_id=$2`;
export async function listEvaluationGateRuns(
	db: Transactional,
	input: {
		project_id: string;
		status?: GateStatus;
		limit?: number;
		offset?: number;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await transaction(db, async (client) => {
			await authorize(
				client,
				input.project_id,
				input.authorization,
				"product_read",
			);
			const limit = Math.min(100, Math.max(1, input.limit ?? 50));
			const offset = Math.max(0, input.offset ?? 0);
			const result = await client.query(
				`SELECT gate.*, count(*) OVER ()::int AS total_count
				 FROM evaluation_gate_runs gate
				 WHERE gate.project_id=$1 AND ($2::text IS NULL OR gate.status=$2)
				 ORDER BY gate.created_at DESC, gate.id DESC LIMIT $3 OFFSET $4`,
				[input.project_id, input.status ?? null, limit, offset],
			);
			return {
				items: result.rows.map((row) => gateRun(row as Row)),
				total: Number(result.rows[0]?.total_count ?? 0),
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
export async function getEvaluationGateRun(
	db: Transactional,
	input: {
		id: string;
		project_id: string;
		authorization: ProjectAuthorization;
	},
): Promise<EvaluationGateRun> {
	try {
		return await transaction(db, async (client) => {
			await authorize(
				client,
				input.project_id,
				input.authorization,
				"product_read",
			);
			const result = await client.query(gateRunLookup, [
				input.id,
				input.project_id,
			]);
			if (!result.rows[0])
				throw new EvaluationGateRepositoryError(
					"NOT_FOUND",
					"Evaluation Gate Run is not available",
				);
			return gateRun(result.rows[0] as Row);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function admitEvaluationGate(
	db: Transactional,
	input: {
		project_id: string;
		approval_id: string;
		definition_version_id: string;
		dataset_version_id: string;
		gate_context: GateContext;
		idempotency_key: string;
		trigger_metadata?: Record<string, unknown>;
		authorization: ProjectAuthorization;
	},
): Promise<{ gate: EvaluationGateRun; run: EvaluationRun }> {
	try {
		const approvalValue = await getEvaluationGateApproval(db, {
			id: input.approval_id,
			project_id: input.project_id,
			authorization: input.authorization,
		});
		if (
			approvalValue.definition_version_id !== input.definition_version_id ||
			approvalValue.dataset_version_id !== input.dataset_version_id ||
			approvalValue.gate_context !== input.gate_context
		)
			throw new EvaluationGateRepositoryError(
				"CONFLICT",
				"Gate invocation must repeat the approved immutable Definition and Dataset Version",
			);
		const runInput: EvaluationRunAdmissionInput = {
			project_id: input.project_id,
			evaluation_selector: approvalValue.evaluation_id,
			definition_version: approvalValue.definition_version,
			idempotency_key: input.idempotency_key,
			trigger_metadata: {
				...input.trigger_metadata,
				gate_context: input.gate_context,
				gate_approval_id: input.approval_id,
			},
			authorization: input.authorization,
			gate: {
				approval_id: input.approval_id,
				definition_version_id: input.definition_version_id,
				dataset_version_id: input.dataset_version_id,
				gate_context: input.gate_context,
			},
		};
		const run = await admitEvaluationRun(db, runInput);
		const gate = await getEvaluationGateRunByEvaluationRun(db, {
			project_id: input.project_id,
			evaluation_run_id: run.id,
			authorization: input.authorization,
		});
		return { gate, run };
	} catch (cause) {
		if (cause instanceof EvaluationGateRepositoryError) throw cause;
		if (cause instanceof EvaluationRunRepositoryError)
			throw new EvaluationGateRepositoryError(cause.code, cause.message, cause);
		throw normalize(cause);
	}
}

async function getEvaluationGateRunByEvaluationRun(
	db: Transactional,
	input: {
		project_id: string;
		evaluation_run_id: string;
		authorization: ProjectAuthorization;
	},
): Promise<EvaluationGateRun> {
	return transaction(db, async (client) => {
		await authorize(
			client,
			input.project_id,
			input.authorization,
			"product_read",
		);
		const result = await client.query(
			"SELECT * FROM evaluation_gate_runs WHERE evaluation_run_id=$1 AND project_id=$2",
			[input.evaluation_run_id, input.project_id],
		);
		if (!result.rows[0])
			throw new EvaluationGateRepositoryError(
				"INTERNAL",
				"Evaluation Gate Run record is unavailable",
			);
		return gateRun(result.rows[0] as Row);
	});
}
