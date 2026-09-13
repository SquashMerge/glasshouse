import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { EvaluationDefinitionInput } from "../schemas/evaluations.js";
import {
	lockActiveAuthorizedProject,
	type ProjectAuthorization,
} from "./project-authorization.js";
import { approvedRedaction } from "./governance.js";
import { policyRedactionOptions, type RedactionOptions } from "./redact.js";
import {
	EvaluationExecutionPolicyError,
	resolveEvaluationExecutionPolicy,
	type EvaluationExecutionBounds,
} from "../lib/evaluation-execution-policy.js";

export type EvaluationRunAdmissionInput = {
	project_id: string;
	evaluation_selector: string;
	definition_version: number;
	idempotency_key: string;
	trigger_metadata?: Record<string, unknown>;
	expected_dataset_id?: string;
	benchmark?: {
		suite_id: string;
		label: string;
		prompt_version?: string | null;
	};
	gate?: {
		approval_id: string;
		definition_version_id: string;
		dataset_version_id: string;
		gate_context: "ci" | "release";
	};
	authorization: ProjectAuthorization;
};

type Transactional = Pick<Pool, "connect">;
type Row = Record<string, unknown>;

type ResolvedSnapshot = {
	target: Record<string, unknown>;
	target_version: string;
	target_fingerprint: string;
	evaluator: Record<string, unknown>;
	evaluator_version: string;
	evaluator_fingerprint: string;
	execution_defaults: Record<string, unknown>;
	limits: Record<string, unknown>;
	execution_bounds: EvaluationExecutionBounds;
	thresholds: Record<string, unknown>;
	sampling: Record<string, unknown>;
	sample_identity: string;
	ordered_item_snapshot: Row[];
	resolved_inputs_hash: string;
};

export type EvaluationRun = {
	id: string;
	organization_id: string;
	project_id: string;
	evaluation_id: string;
	definition_version_id: string;
	dataset_version_id: string;
	dataset_id: string;
	experiment_id: string;
	experiment_agent_id: string | null;
	experiment_name: string | null;
	benchmark_run_id: string | null;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	requested_by_actor_id: string;
	idempotency_key: string;
	request_hash: string;
	resolved_inputs_hash: string;
	trigger_metadata: Record<string, unknown>;
	snapshot: ResolvedSnapshot;
	created_at: string;
	updated_at: string;
	replayed: boolean;
};

export type EvaluationRunLifecycleStatus = {
	id: string;
	project_id: string;
	status: EvaluationRun["status"];
	counts: {
		total: number;
		pending: number;
		running: number;
		completed: number;
		failed: number;
		cancelled: number;
	};
	attempts: number;
	created_at: string;
	updated_at: string;
	terminal_reason: string | null;
	pinned_inputs: {
		definition_version_id: string;
		dataset_version_id: string;
		resolved_inputs_hash: string;
		target: Record<string, unknown>;
		target_version: string;
		target_fingerprint: string;
		evaluator: Record<string, unknown>;
		evaluator_version: string;
		evaluator_fingerprint: string;
		execution_defaults: Record<string, unknown>;
		thresholds: Record<string, unknown>;
		limits: Record<string, unknown>;
		execution_bounds: EvaluationExecutionBounds;
		sample: {
			strategy: string;
			sample_size: number;
			seed: number;
			selected_count: number;
			sample_identity: string;
		};
		provenance: {
			items: number;
			with_source_trace: number;
			with_source_observation: number;
		};
	};
	metrics: {
		evaluated: number;
		passed: number;
		failed: number;
		pass_rate: number | null;
		cost_usd: number | null;
		provider_calls_used: number;
		max_provider_calls: number;
		max_cost_usd: number | null;
		duration_ms: number | null;
		max_duration_seconds: number | null;
		score_counts: Record<string, number>;
	};
	evidence_policy: {
		retention: "project_policy";
		max_items: number;
		max_field_bytes: number;
		redaction: string;
	};
	items: EvaluationRunItemEvidence[];
	items_truncated: boolean;
};

export type EvaluationRunItemEvidence = {
	task_id: string;
	item_key: string;
	position: number;
	status: EvaluationRun["status"];
	attempt_count: number;
	input: Record<string, unknown>;
	expected_output: Record<string, unknown> | null;
	output: Record<string, unknown> | null;
	scores: Record<string, number>;
	error_classification: string | null;
	error_message: string | null;
	cost_usd: number | null;
	evaluator_rationale: Record<string, unknown> | null;
	trace_id: string | null;
	agent_version: string | null;
	provenance: {
		source_trace_id: string | null;
		source_observation_id: string | null;
		evaluation_trace_id: string | null;
	};
	timing: {
		started_at: string | null;
		completed_at: string | null;
		duration_ms: number | null;
	};
	redaction: {
		applied: boolean;
		bounded: boolean;
		fields: string[];
		max_bytes: number;
	};
};

export type EvaluationRunLifecycleEvent = {
	id: number;
	run_id: string;
	event_type: "run_status" | "task_status" | "result_recorded";
	task_id: string | null;
	payload: Record<string, unknown>;
	created_at: string;
};

export class EvaluationRunRepositoryError extends Error {
	readonly status: 400 | 404 | 409 | 429 | 500;
	constructor(
		readonly code:
			| "BAD_REQUEST"
			| "NOT_FOUND"
			| "CONFLICT"
			| "TOO_MANY_REQUESTS"
			| "INTERNAL",
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "EvaluationRunRepositoryError";
		this.status =
			code === "BAD_REQUEST"
				? 400
				: code === "NOT_FOUND"
					? 404
					: code === "CONFLICT"
						? 409
						: code === "TOO_MANY_REQUESTS"
							? 429
							: 500;
	}
}

function normalize(cause: unknown): EvaluationRunRepositoryError {
	if (cause instanceof EvaluationRunRepositoryError) return cause;
	if (cause instanceof EvaluationExecutionPolicyError)
		return new EvaluationRunRepositoryError(
			"BAD_REQUEST",
			cause.message,
			cause,
		);
	if (
		typeof cause === "object" &&
		cause !== null &&
		"code" in cause &&
		cause.code === "23505"
	)
		return new EvaluationRunRepositoryError(
			"CONFLICT",
			"An Evaluation Run with this idempotency key already exists",
			cause,
		);
	if (
		typeof cause === "object" &&
		cause !== null &&
		"code" in cause &&
		cause.code === "23503"
	)
		return new EvaluationRunRepositoryError(
			"NOT_FOUND",
			"Referenced Evaluation or Dataset Version is not available",
			cause,
		);
	return new EvaluationRunRepositoryError(
		"INTERNAL",
		"Evaluation Run admission failed",
		cause,
	);
}

function isRetryable(cause: unknown): boolean {
	const code = (cause as { code?: unknown } | null)?.code;
	return code === "40001" || code === "40P01";
}

async function serializable<T>(
	db: Transactional,
	callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const client = await db.connect();
		try {
			await client.query("BEGIN");
			await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
			const value = await callback(client);
			await client.query("COMMIT");
			return value;
		} catch (cause) {
			await client.query("ROLLBACK").catch(() => {});
			if (attempt === 0 && isRetryable(cause)) continue;
			throw cause;
		} finally {
			client.release();
		}
	}
	throw new Error("Evaluation Run admission retries exhausted");
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

function hash(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

function object(value: unknown, field: string): Record<string, unknown> {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch (cause) {
			throw new EvaluationRunRepositoryError(
				"BAD_REQUEST",
				`Definition Version contains invalid ${field}`,
				cause,
			);
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new EvaluationRunRepositoryError(
			"BAD_REQUEST",
			`Definition Version contains invalid ${field}`,
		);
	return value as Record<string, unknown>;
}

function text(row: Row, field: string): string {
	if (typeof row[field] !== "string" || row[field] === "")
		throw new EvaluationRunRepositoryError("INTERNAL", `Invalid ${field}`);
	return row[field] as string;
}

function nullableText(row: Row, field: string): string | null {
	return row[field] == null ? null : text(row, field);
}

function timestamp(row: Row, field: string): string {
	if (row[field] instanceof Date) return (row[field] as Date).toISOString();
	return text(row, field);
}

function nullableTimestamp(row: Row, field: string): string | null {
	return row[field] == null ? null : timestamp(row, field);
}

const EVIDENCE_MAX_ITEMS = 100;
const EVIDENCE_MAX_FIELD_BYTES = 32 * 1024;
const SENSITIVE_KEY =
	/(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|private[_-]?key)/i;

type EvidenceRedactionState = {
	applied: boolean;
	bounded: boolean;
	fields: string[];
	options: RedactionOptions;
};

function evidenceKeyIsSensitive(
	key: string,
	options: RedactionOptions,
): boolean {
	return SENSITIVE_KEY.test(key) || options.redactKeys.includes(key);
}

function evidenceValue(
	value: unknown,
	state: EvidenceRedactionState,
	path: string,
	depth = 0,
): unknown {
	if (depth > 8) {
		state.bounded = true;
		return { redacted: true, reason: "depth_limit" };
	}
	if (typeof value === "string") {
		if (state.options.redactInput && value) {
			state.applied = true;
			if (state.fields.length < 32) state.fields.push(path);
			return "[REDACTED]";
		}
		if (new TextEncoder().encode(value).byteLength <= EVIDENCE_MAX_FIELD_BYTES)
			return value;
		state.bounded = true;
		return {
			redacted: true,
			reason: "field_size_limit",
			bytes: EVIDENCE_MAX_FIELD_BYTES,
		};
	}
	if (Array.isArray(value)) {
		if (value.length > 128) state.bounded = true;
		return value
			.slice(0, 128)
			.map((item, index) =>
				evidenceValue(item, state, `${path}[${index}]`, depth + 1),
			);
	}
	if (!value || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>);
	const keyValueKey =
		typeof (value as Record<string, unknown>).key === "string"
			? ((value as Record<string, unknown>).key as string)
			: undefined;
	const redactedKeyValue =
		keyValueKey !== undefined &&
		evidenceKeyIsSensitive(keyValueKey, state.options);
	if (entries.length > 128) state.bounded = true;
	const output: Record<string, unknown> = {};
	for (const [key, item] of entries.slice(0, 128)) {
		const childPath = path ? `${path}.${key}` : key;
		if (
			evidenceKeyIsSensitive(key, state.options) ||
			(key === "value" && redactedKeyValue) ||
			state.options.redactInput
		) {
			state.applied = true;
			if (state.fields.length < 32) state.fields.push(childPath);
			output[key] = "[REDACTED]";
			continue;
		}
		output[key] = evidenceValue(item, state, childPath, depth + 1);
	}
	return output;
}

function safeEvidenceObject(
	value: unknown,
	state: EvidenceRedactionState,
	path: string,
): Record<string, unknown> | null {
	if (value == null) return null;
	const parsed =
		typeof value === "string"
			? (() => {
					try {
						return JSON.parse(value);
					} catch {
						return {};
					}
				})()
			: value;
	const safe = evidenceValue(parsed, state, path);
	return safe && typeof safe === "object" && !Array.isArray(safe)
		? (safe as Record<string, unknown>)
		: {};
}

function emptyEvidenceState(
	options: RedactionOptions = { redactInput: false, redactKeys: [] },
): EvidenceRedactionState {
	return {
		applied: false,
		bounded: false,
		fields: [],
		options,
	};
}

async function withTransaction<T>(
	db: Transactional,
	callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
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

function lifecycleStatus(
	row: Row,
	snapshotRow: Row,
	evidenceRows: Row[] = [],
	redactionOptions: RedactionOptions = { redactInput: false, redactKeys: [] },
): EvaluationRunLifecycleStatus {
	const provenance = {
		items: Number(snapshotRow.selected_count ?? row.total ?? 0),
		with_source_trace: Number(snapshotRow.with_source_trace ?? 0),
		with_source_observation: Number(snapshotRow.with_source_observation ?? 0),
	};
	const sampling = object(snapshotRow.sampling, "sampling");
	const limits = object(snapshotRow.limits, "limits");
	const executionBounds = object(
		snapshotRow.execution_bounds,
		"execution_bounds",
	) as EvaluationExecutionBounds;
	const metrics = {
		evaluated: Number(row.evaluated ?? 0),
		passed: Number(row.passed ?? 0),
		failed: Number(row.evaluated_failed ?? 0),
		pass_rate:
			Number(row.evaluated ?? 0) > 0
				? Number(row.passed ?? 0) / Number(row.evaluated)
				: null,
		cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
		provider_calls_used: Number(row.provider_call_count ?? 0),
		max_provider_calls: Number(executionBounds.max_provider_calls),
		max_cost_usd:
			limits.max_cost_usd == null ? null : Number(limits.max_cost_usd),
		duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
		max_duration_seconds:
			limits.max_duration_seconds == null
				? null
				: Number(limits.max_duration_seconds),
		score_counts: {
			passed: Number(row.passed ?? 0),
			failed: Number(row.evaluated_failed ?? 0),
		},
	};
	return {
		id: text(row, "id"),
		project_id: text(row, "project_id"),
		status: text(row, "status") as EvaluationRun["status"],
		counts: {
			total: Number(row.total ?? 0),
			pending: Number(row.pending ?? 0),
			running: Number(row.running ?? 0),
			completed: Number(row.completed ?? 0),
			failed: Number(row.failed ?? 0),
			cancelled: Number(row.cancelled ?? 0),
		},
		attempts: Number(row.attempts ?? 0),
		created_at: timestamp(row, "created_at"),
		updated_at: timestamp(row, "updated_at"),
		terminal_reason: nullableText(row, "terminal_reason"),
		pinned_inputs: {
			definition_version_id: text(row, "definition_version_id"),
			dataset_version_id: text(row, "dataset_version_id"),
			resolved_inputs_hash: text(row, "resolved_inputs_hash"),
			target: object(snapshotRow.target, "target"),
			target_version: text(snapshotRow, "target_version"),
			target_fingerprint: text(snapshotRow, "target_fingerprint"),
			evaluator: object(snapshotRow.evaluator, "evaluator"),
			evaluator_version: text(snapshotRow, "evaluator_version"),
			evaluator_fingerprint:
				snapshotRow.evaluator_fingerprint == null
					? hash(snapshotRow.evaluator)
					: text(snapshotRow, "evaluator_fingerprint"),
			execution_defaults: object(
				snapshotRow.execution_defaults,
				"execution_defaults",
			),
			thresholds: object(snapshotRow.thresholds, "thresholds"),
			limits,
			execution_bounds: executionBounds,
			sample: {
				strategy: text(sampling, "strategy"),
				sample_size: Number(sampling.sample_size),
				seed: Number(sampling.seed),
				selected_count: provenance.items,
				sample_identity: text(snapshotRow, "sample_identity"),
			},
			provenance,
		},
		metrics,
		evidence_policy: {
			retention: "project_policy",
			max_items: EVIDENCE_MAX_ITEMS,
			max_field_bytes: EVIDENCE_MAX_FIELD_BYTES,
			redaction: "sensitive-key redaction and bounded JSON evidence",
		},
		items: evidenceRows.slice(0, EVIDENCE_MAX_ITEMS).map((item) => {
			const redaction = emptyEvidenceState(redactionOptions);
			return {
				task_id: text(item, "task_id"),
				item_key: text(item, "item_key"),
				position: Number(item.position),
				status: text(item, "status") as EvaluationRun["status"],
				attempt_count: Number(item.attempt_count ?? 0),
				input: safeEvidenceObject(item.input, redaction, "input") ?? {},
				expected_output: safeEvidenceObject(
					item.expected_output,
					redaction,
					"expected_output",
				),
				output: safeEvidenceObject(item.output, redaction, "output"),
				scores: safeEvidenceObject(item.scores, redaction, "scores") as Record<
					string,
					number
				>,
				error_classification: nullableText(item, "error_classification"),
				error_message: nullableText(item, "error_message"),
				cost_usd: item.cost_usd == null ? null : Number(item.cost_usd),
				evaluator_rationale: safeEvidenceObject(
					item.evaluator_rationale,
					redaction,
					"evaluator_rationale",
				),
				agent_version: nullableText(item, "agent_version"),
				trace_id: nullableText(item, "trace_id"),
				provenance: {
					source_trace_id: nullableText(item, "source_trace_id"),
					source_observation_id: nullableText(item, "source_observation_id"),
					evaluation_trace_id: nullableText(item, "trace_id"),
				},
				timing: {
					started_at: nullableTimestamp(item, "started_at"),
					completed_at: nullableTimestamp(item, "completed_at"),
					duration_ms:
						item.duration_ms == null ? null : Number(item.duration_ms),
				},
				redaction: {
					applied: redaction.applied,
					bounded: redaction.bounded,
					fields: redaction.fields,
					max_bytes: EVIDENCE_MAX_FIELD_BYTES,
				},
			};
		}),
		items_truncated: evidenceRows.length > EVIDENCE_MAX_ITEMS,
	};
}

const lifecycleStatusQuery = `SELECT run.id, run.project_id, run.status,
    run.created_at, run.updated_at, run.terminal_reason, run.provider_call_count,
    run.definition_version_id, run.dataset_version_id, run.resolved_inputs_hash,
    count(task.id)::int AS total,
    count(task.id) FILTER (WHERE task.status = 'pending')::int AS pending,
    count(task.id) FILTER (WHERE task.status = 'running')::int AS running,
    count(task.id) FILTER (WHERE task.status = 'completed')::int AS completed,
    count(task.id) FILTER (WHERE task.status = 'failed')::int AS failed,
    count(task.id) FILTER (WHERE task.status = 'cancelled')::int AS cancelled,
    coalesce(sum(task.attempt_count), 0)::int AS attempts,
    count(result.id)::int AS evaluated,
    count(result.id) FILTER (WHERE result.status = 'completed'
      AND EXISTS (SELECT 1 FROM jsonb_each_text(result.scores) score
                  WHERE score.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
                    AND score.value::numeric >= 1))::int AS passed,
    count(result.id) FILTER (WHERE result.status IS NULL OR result.status <> 'completed'
      OR NOT EXISTS (SELECT 1 FROM jsonb_each_text(result.scores) score
                    WHERE score.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
                      AND score.value::numeric >= 1))::int AS evaluated_failed,
    sum(result.cost_usd) AS cost_usd,
    sum(result.duration_ms)::int AS duration_ms
 FROM evaluation_runs run
 LEFT JOIN experiment_tasks task
   ON task.evaluation_run_id = run.id AND task.project_id = run.project_id
 LEFT JOIN experiment_results result
   ON result.experiment_id = task.experiment_id
  AND result.evaluation_run_id = run.id
  AND result.evaluation_run_item_id = task.evaluation_run_item_id
  AND result.project_id = run.project_id
 WHERE run.id = $1 AND run.project_id = $2
 GROUP BY run.id`;

const lifecycleEvidenceQuery = `SELECT task.id AS task_id, item.item_key, item.position, task.status, task.attempt_count,
    item.input, item.expected_output, item.source_trace_id, item.source_observation_id,
    COALESCE(result.error_classification, task.last_error_classification) AS error_classification,
    COALESCE(result.error_message, task.last_error_message) AS error_message,
    result.output, result.scores, result.cost_usd, result.evaluator_rationale,
    result.agent_version, result.duration_ms, result.trace_id,
    task.started_at, task.completed_at,
    count(*) OVER ()::int AS total_count
 FROM experiment_tasks task
 JOIN evaluation_run_items item ON item.id=task.evaluation_run_item_id AND item.project_id=task.project_id
 LEFT JOIN experiment_results result
   ON result.experiment_id=task.experiment_id
  AND result.project_id=task.project_id
  AND result.evaluation_run_item_id=task.evaluation_run_item_id
 WHERE task.evaluation_run_id=$1 AND task.project_id=$2
 ORDER BY item.position ASC, task.id ASC LIMIT $3 OFFSET $4`;

async function lifecycleStatusWithEvidence(
	client: PoolClient,
	id: string,
	projectId: string,
	limit = EVIDENCE_MAX_ITEMS + 1,
	offset = 0,
	redactionOptions: RedactionOptions = { redactInput: false, redactKeys: [] },
) {
	const status = await client.query(lifecycleStatusQuery, [id, projectId]);
	if (!status.rows[0])
		throw new EvaluationRunRepositoryError(
			"NOT_FOUND",
			"Evaluation Run is not available",
		);
	const snapshot = await client.query(
		`SELECT inputs.*, count(item.id)::int AS selected_count,
        count(item.id) FILTER (WHERE item.source_trace_id IS NOT NULL)::int AS with_source_trace,
        count(item.id) FILTER (WHERE item.source_observation_id IS NOT NULL)::int AS with_source_observation
     FROM evaluation_run_inputs inputs
     JOIN evaluation_runs run ON run.id=inputs.run_id AND run.project_id=inputs.project_id
     LEFT JOIN evaluation_run_items item ON item.run_id=run.id AND item.project_id=run.project_id
     WHERE inputs.run_id=$1 AND inputs.project_id=$2
     GROUP BY inputs.run_id`,
		[id, projectId],
	);
	if (!snapshot.rows[0])
		throw new EvaluationRunRepositoryError(
			"INTERNAL",
			"Evaluation Run input snapshot is unavailable",
		);
	const evidence = await client.query(lifecycleEvidenceQuery, [
		id,
		projectId,
		limit,
		offset,
	]);
	return lifecycleStatus(
		status.rows[0] as Row,
		snapshot.rows[0] as Row,
		evidence.rows as Row[],
		redactionOptions,
	);
}

function safeMetadata(value: Record<string, unknown> | undefined) {
	if (value === undefined) return {};
	const output: Record<string, string | number | boolean | null> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!/^[a-z][a-z0-9_]{0,31}$/.test(key))
			throw new EvaluationRunRepositoryError(
				"BAD_REQUEST",
				"Trigger metadata keys must be lowercase identifiers",
			);
		if (
			item !== null &&
			typeof item !== "string" &&
			typeof item !== "number" &&
			typeof item !== "boolean"
		)
			throw new EvaluationRunRepositoryError(
				"BAD_REQUEST",
				"Trigger metadata must contain scalar values only",
			);
		if (typeof item === "string" && item.length > 200)
			throw new EvaluationRunRepositoryError(
				"BAD_REQUEST",
				"Trigger metadata values are too long",
			);
		output[key] = item;
	}
	return output;
}

function requestHash(input: EvaluationRunAdmissionInput, metadata: Row) {
	return hash({
		operation: "evaluation_run_admission",
		organization_id: input.authorization.organization_id,
		project_id: input.project_id,
		actor_id: input.authorization.actor_id,
		evaluation_selector: input.evaluation_selector,
		definition_version: input.definition_version,
		expected_dataset_id: input.expected_dataset_id ?? null,
		benchmark: input.benchmark ?? null,
		gate: input.gate ?? null,
		trigger_metadata: metadata,
	});
}

function definitionFields(row: Row) {
	const fields = {
		dataset_version_id: text(row, "dataset_version_id"),
		sampling: object(row.sampling, "sampling"),
		evaluator: object(row.evaluator, "evaluator"),
		target: object(row.target, "target"),
		execution_defaults: object(row.execution_defaults, "execution_defaults"),
		limits: object(row.limits, "limits"),
		thresholds: object(row.thresholds, "thresholds"),
	};
	const parsed = EvaluationDefinitionInput.safeParse(fields);
	if (!parsed.success) {
		throw new EvaluationRunRepositoryError(
			"BAD_REQUEST",
			"The selected Definition Version is not an executable v1 contract",
		);
	}
	return parsed.data;
}

async function validateGateApproval(
	client: PoolClient,
	input: EvaluationRunAdmissionInput,
): Promise<void> {
	const gate = input.gate;
	if (!gate) return;
	const result = await client.query(
		`SELECT approval.id, approval.definition_version_id, approval.dataset_version_id,
		        approval.gate_context, approval.minimum_pass_rate,
		        definition.evaluation_id, definition.version,
		        definition.content_hash, dataset_version.content_hash AS dataset_content_hash
		 FROM evaluation_gate_approvals approval
		 JOIN evaluation_definition_versions definition
		   ON definition.id=approval.definition_version_id
		  AND definition.project_id=approval.project_id
		 JOIN dataset_versions dataset_version
		   ON dataset_version.id=approval.dataset_version_id
		  AND dataset_version.project_id=approval.project_id
		 WHERE approval.id=$1
		   AND approval.organization_id=$2
		   AND approval.project_id=$3
		   AND approval.revoked_at IS NULL
		   AND approval.gate_context=$4
		   AND approval.definition_content_hash=definition.content_hash
		   AND approval.dataset_content_hash=dataset_version.content_hash
		 FOR UPDATE OF approval`,
		[
			gate.approval_id,
			input.authorization.organization_id,
			input.project_id,
			gate.gate_context,
		],
	);
	const row = result.rows[0] as Row | undefined;
	if (!row)
		throw new EvaluationRunRepositoryError(
			"CONFLICT",
			"Evaluation Gate approval is not active or is not available to this Project",
		);
	if (
		text(row, "definition_version_id") !== gate.definition_version_id ||
		text(row, "dataset_version_id") !== gate.dataset_version_id ||
		text(row, "evaluation_id") !== input.evaluation_selector ||
		Number(row.version) !== input.definition_version
	)
		throw new EvaluationRunRepositoryError(
			"CONFLICT",
			"Evaluation Gate invocation does not match its approved immutable Definition Version",
		);
}

function snapshotFor(
	definition: ReturnType<typeof definitionFields>,
	items: Row[],
	policy: ReturnType<typeof resolveEvaluationExecutionPolicy>,
): ResolvedSnapshot {
	const target = {
		...definition.target,
		model: policy.model,
		provider: policy.provider,
	};
	const evaluator = { ...definition.evaluator };
	const executionDefaults = { ...definition.execution_defaults };
	const limits = { ...definition.limits };
	const thresholds = { ...definition.thresholds };
	const sampling = { ...definition.sampling };
	const sampleIdentity = hash({
		dataset_version_id: definition.dataset_version_id,
		items: items.map((item) => ({
			id: text(item, "id"),
			item_key: text(item, "item_key"),
			position: Number(item.position),
		})),
	});
	const snapshot: Omit<ResolvedSnapshot, "resolved_inputs_hash"> = {
		target,
		target_version: "configured_llm:v1",
		target_fingerprint: hash(target),
		evaluator,
		evaluator_version: text(evaluator, "version"),
		evaluator_fingerprint: hash(evaluator),
		execution_defaults: executionDefaults,
		limits,
		execution_bounds: policy.bounds,
		thresholds,
		sampling,
		sample_identity: sampleIdentity,
		ordered_item_snapshot: items,
	};
	return {
		...snapshot,
		resolved_inputs_hash: hash(snapshot),
	};
}

function runFromRow(
	row: Row,
	input: EvaluationRunAdmissionInput,
	snapshot: ResolvedSnapshot,
	replayed: boolean,
): EvaluationRun {
	return {
		id: text(row, "id"),
		organization_id: text(row, "organization_id"),
		project_id: text(row, "project_id"),
		evaluation_id: text(row, "evaluation_id"),
		definition_version_id: text(row, "definition_version_id"),
		dataset_version_id: text(row, "dataset_version_id"),
		dataset_id: text(row, "dataset_id"),
		experiment_id: text(row, "experiment_id"),
		experiment_agent_id: nullableText(row, "experiment_agent_id"),
		experiment_name: nullableText(row, "experiment_name"),
		benchmark_run_id: nullableText(row, "benchmark_run_id"),
		status: text(row, "status") as EvaluationRun["status"],
		requested_by_actor_id: text(row, "requested_by_actor_id"),
		idempotency_key: text(row, "idempotency_key"),
		request_hash: text(row, "request_hash"),
		resolved_inputs_hash: text(row, "resolved_inputs_hash"),
		trigger_metadata: object(row.trigger_metadata, "trigger_metadata"),
		snapshot,
		created_at: timestamp(row, "created_at"),
		updated_at: timestamp(row, "updated_at"),
		replayed,
	};
}

function experimentConfig(snapshot: ResolvedSnapshot) {
	return {
		model: snapshot.target.model,
		provider: snapshot.target.provider,
		system_prompt: snapshot.target.system_prompt,
		evaluator: snapshot.evaluator.kind,
		expected_output_path: snapshot.evaluator.expected_output_path,
		output_path: snapshot.evaluator.output_path,
		temperature: snapshot.execution_defaults.temperature,
		max_tokens: snapshot.execution_defaults.max_tokens,
		limits: snapshot.limits,
	};
}

function itemSnapshot(item: Row) {
	return {
		dataset_version_item_id: text(item, "id"),
		item_key: text(item, "item_key"),
		position: Number(item.position),
		input: object(item.input, "input"),
		expected_output: item.expected_output ?? null,
		metadata: object(item.metadata ?? {}, "metadata"),
		source_trace_id: item.source_trace_id ?? null,
		source_observation_id: item.source_observation_id ?? null,
	};
}

async function assertEvaluationRunCapacity(
	client: PoolClient,
	input: {
		project_id: string;
		actor_id: string;
		bounds: EvaluationExecutionBounds;
	},
) {
	const capacity = await client.query(
		`SELECT count(*) FILTER (WHERE status='active')::int AS project_active,
            count(*) FILTER (WHERE status='active' AND actor_id=$2::uuid)::int AS actor_active
         FROM evaluation_run_capacity_admissions
         WHERE project_id=$1`,
		[input.project_id, input.actor_id],
	);
	const row = capacity.rows[0] as Row | undefined;
	if (
		Number(row?.project_active ?? 0) >= input.bounds.max_active_runs_per_project
	)
		throw new EvaluationRunRepositoryError(
			"TOO_MANY_REQUESTS",
			"Project Evaluation Run concurrency limit is reached",
		);
	if (Number(row?.actor_active ?? 0) >= input.bounds.max_active_runs_per_actor)
		throw new EvaluationRunRepositoryError(
			"TOO_MANY_REQUESTS",
			"Actor Evaluation Run concurrency limit is reached",
		);
}

async function activateEvaluationRunCapacity(
	client: PoolClient,
	input: {
		run_id: string;
		organization_id: string;
		project_id: string;
		actor_id: string;
	},
) {
	const result = await client.query(
		`INSERT INTO evaluation_run_capacity_admissions
            (run_id, organization_id, project_id, actor_id, status)
         VALUES ($1,$2,$3,$4,'active')
         ON CONFLICT (run_id) DO UPDATE
         SET status='active', acquired_at=now(), released_at=NULL, release_reason=NULL
         WHERE evaluation_run_capacity_admissions.status='released'
         RETURNING run_id`,
		[input.run_id, input.organization_id, input.project_id, input.actor_id],
	);
	if (!result.rows[0])
		throw new EvaluationRunRepositoryError(
			"CONFLICT",
			"Evaluation Run already holds execution capacity",
		);
}

export async function admitEvaluationRun(
	db: Transactional,
	input: EvaluationRunAdmissionInput,
): Promise<EvaluationRun> {
	try {
		const metadata = safeMetadata(input.trigger_metadata);
		if (!input.idempotency_key.trim())
			throw new EvaluationRunRepositoryError(
				"BAD_REQUEST",
				"Idempotency-Key is required",
			);
		return await serializable(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Project is not available",
				);

			const expectedRequestHash = requestHash(input, metadata);
			const existing = await client.query(
				"SELECT run.*, experiment.id AS experiment_id, experiment.agent_id AS experiment_agent_id, experiment.name AS experiment_name, benchmark.id AS benchmark_run_id, version.dataset_id FROM evaluation_runs run LEFT JOIN experiments experiment ON experiment.evaluation_run_id = run.id AND experiment.project_id = run.project_id LEFT JOIN benchmark_runs benchmark ON benchmark.evaluation_run_id = run.id AND benchmark.project_id = run.project_id JOIN dataset_versions version ON version.id = run.dataset_version_id AND version.project_id = run.project_id WHERE run.project_id=$1 AND run.idempotency_key=$2",
				[input.project_id, input.idempotency_key],
			);
			if (existing.rows[0]) {
				const row = existing.rows[0] as Row;
				await client.query(
					"SELECT id FROM evaluation_runs WHERE id=$1 AND project_id=$2 FOR UPDATE",
					[text(row, "id"), input.project_id],
				);
				if (text(row, "request_hash") !== expectedRequestHash)
					throw new EvaluationRunRepositoryError(
						"CONFLICT",
						"Idempotency-Key is already bound to a different immutable request",
					);
				const snapshotRows = await client.query(
					"SELECT input.* FROM evaluation_run_inputs input WHERE input.run_id=$1 AND input.project_id=$2",
					[text(row, "id"), input.project_id],
				);
				const snapshotRow = snapshotRows.rows[0] as Row | undefined;
				if (!snapshotRow || !Array.isArray(snapshotRow.ordered_item_snapshot))
					throw new EvaluationRunRepositoryError(
						"INTERNAL",
						"Evaluation Run input snapshot is unavailable",
					);
				const snapshot: ResolvedSnapshot = {
					target: object(snapshotRow.target, "target"),
					target_version: text(snapshotRow, "target_version"),
					target_fingerprint: text(snapshotRow, "target_fingerprint"),
					evaluator: object(snapshotRow.evaluator, "evaluator"),
					evaluator_version: text(snapshotRow, "evaluator_version"),
					evaluator_fingerprint:
						snapshotRow.evaluator_fingerprint == null
							? hash(snapshotRow.evaluator)
							: text(snapshotRow, "evaluator_fingerprint"),
					execution_defaults: object(
						snapshotRow.execution_defaults,
						"execution_defaults",
					),
					limits: object(snapshotRow.limits ?? {}, "limits"),
					execution_bounds: object(
						snapshotRow.execution_bounds ?? {},
						"execution_bounds",
					) as EvaluationExecutionBounds,
					thresholds: object(snapshotRow.thresholds, "thresholds"),
					sampling: object(snapshotRow.sampling, "sampling"),
					sample_identity: text(snapshotRow, "sample_identity"),
					ordered_item_snapshot: snapshotRow.ordered_item_snapshot,
					resolved_inputs_hash: text(snapshotRow, "resolved_inputs_hash"),
				};
				return runFromRow(row, input, snapshot, true);
			}

			await validateGateApproval(client, input);
			const definitionResult = await client.query(
				`SELECT definition.*, evaluation.name AS evaluation_name, dataset_version.dataset_id,
				        dataset_version.content_hash AS dataset_content_hash
				 FROM evaluation_definition_versions definition
				 JOIN evaluations evaluation
				   ON evaluation.id = definition.evaluation_id
				  AND evaluation.project_id = definition.project_id
				 JOIN dataset_versions dataset_version
				   ON dataset_version.id = definition.dataset_version_id
				  AND dataset_version.project_id = definition.project_id
				 JOIN datasets dataset
				   ON dataset.id = dataset_version.dataset_id
				  AND dataset.project_id = dataset_version.project_id
				 WHERE definition.project_id=$1
				   AND (evaluation.id::text=$2 OR evaluation.slug=$2)
				   AND definition.version=$3
				   AND evaluation.archived_at IS NULL
				   AND evaluation.tombstoned_at IS NULL
				   AND dataset.archived_at IS NULL
				   AND ($4::uuid IS NULL OR dataset.id=$4)
				   AND ($5::uuid IS NULL OR EXISTS (
						SELECT 1 FROM benchmark_suites suite
						WHERE suite.id=$5 AND suite.project_id=$1 AND suite.dataset_id=dataset.id
				   ))
				   AND ($6::uuid IS NULL OR definition.id=$6)
				   AND ($7::uuid IS NULL OR definition.dataset_version_id=$7)
				 FOR UPDATE OF definition, evaluation, dataset_version, dataset`,
				[
					input.project_id,
					input.evaluation_selector,
					input.definition_version,
					input.expected_dataset_id ?? null,
					input.benchmark?.suite_id ?? null,
					input.gate?.definition_version_id ?? null,
					input.gate?.dataset_version_id ?? null,
				],
			);
			const definitionRow = definitionResult.rows[0] as Row | undefined;
			if (!definitionRow)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Executable Evaluation Definition Version is not available",
				);
			const definition = definitionFields(definitionRow);
			const requestedSampleSize = Number(definition.sampling.sample_size);
			const policy = resolveEvaluationExecutionPolicy(
				definition.target,
				requestedSampleSize,
			);
			const itemResult = await client.query(
				"SELECT item.* FROM dataset_version_items item WHERE item.project_id=$1 AND item.dataset_version_id=$2 ORDER BY item.position ASC, item.item_key ASC, item.id ASC LIMIT $3",
				[input.project_id, definition.dataset_version_id, requestedSampleSize],
			);
			const allItems = itemResult.rows as Row[];
			if (allItems.length === 0)
				throw new EvaluationRunRepositoryError(
					"BAD_REQUEST",
					"The selected Dataset Version contains no items",
				);
			const selectedItems = allItems;
			if (selectedItems.some((item) => item.expected_output == null))
				throw new EvaluationRunRepositoryError(
					"BAD_REQUEST",
					"Every selected Dataset Version item needs expected output",
				);
			const snapshot = snapshotFor(definition, selectedItems, policy);
			await assertEvaluationRunCapacity(client, {
				project_id: input.project_id,
				actor_id: input.authorization.actor_id,
				bounds: snapshot.execution_bounds,
			});
			const runId = randomUUID();
			const experimentId = randomUUID();
			const insertedRun = await client.query(
				"INSERT INTO evaluation_runs (id, organization_id, project_id, evaluation_id, definition_version_id, dataset_version_id, requested_by_actor_id, status, idempotency_key, request_hash, resolved_inputs_hash, trigger_metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11::jsonb) RETURNING *",
				[
					runId,
					input.authorization.organization_id,
					input.project_id,
					text(definitionRow, "evaluation_id"),
					text(definitionRow, "id"),
					definition.dataset_version_id,
					input.authorization.actor_id,
					input.idempotency_key,
					expectedRequestHash,
					snapshot.resolved_inputs_hash,
					JSON.stringify(metadata),
				],
			);
			const runRow = (insertedRun.rows[0] as Row | undefined) ?? {
				id: runId,
				organization_id: input.authorization.organization_id,
				project_id: input.project_id,
				evaluation_id: text(definitionRow, "evaluation_id"),
				definition_version_id: text(definitionRow, "id"),
				dataset_version_id: definition.dataset_version_id,
				dataset_id: text(definitionRow, "dataset_id"),
				experiment_id: experimentId,
				experiment_agent_id: null,
				experiment_name: `${text(definitionRow, "evaluation_name")} run v${input.definition_version}`,
				status: "pending",
				requested_by_actor_id: input.authorization.actor_id,
				idempotency_key: input.idempotency_key,
				request_hash: expectedRequestHash,
				resolved_inputs_hash: snapshot.resolved_inputs_hash,
				trigger_metadata: metadata,
				created_at: new Date(),
				updated_at: new Date(),
			};
			await client.query(
				"SELECT set_config('astraea.evaluation_run_admission_run_id', $1, true)",
				[runId],
			);
			await activateEvaluationRunCapacity(client, {
				run_id: runId,
				organization_id: input.authorization.organization_id,
				project_id: input.project_id,
				actor_id: input.authorization.actor_id,
			});
			await client.query(
				"INSERT INTO evaluation_run_inputs (run_id, organization_id, project_id, target, target_version, target_fingerprint, evaluator, evaluator_version, evaluator_fingerprint, execution_defaults, thresholds, sampling, sample_identity, ordered_item_snapshot, resolved_inputs_hash, limits, execution_bounds) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16::jsonb,$17::jsonb)",
				[
					runId,
					input.authorization.organization_id,
					input.project_id,
					JSON.stringify(snapshot.target),
					snapshot.target_version,
					snapshot.target_fingerprint,
					JSON.stringify(snapshot.evaluator),
					snapshot.evaluator_version,
					snapshot.evaluator_fingerprint,
					JSON.stringify(snapshot.execution_defaults),
					JSON.stringify(snapshot.thresholds),
					JSON.stringify(snapshot.sampling),
					snapshot.sample_identity,
					JSON.stringify(snapshot.ordered_item_snapshot),
					snapshot.resolved_inputs_hash,
					JSON.stringify(snapshot.limits),
					JSON.stringify(snapshot.execution_bounds),
				],
			);
			for (const item of selectedItems) {
				const copy = itemSnapshot(item);
				await client.query(
					"INSERT INTO evaluation_run_items (organization_id, project_id, run_id, dataset_version_item_id, position, item_key, input, expected_output, metadata, source_trace_id, source_observation_id) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)",
					[
						input.authorization.organization_id,
						input.project_id,
						runId,
						copy.dataset_version_item_id,
						copy.position,
						copy.item_key,
						JSON.stringify(copy.input),
						copy.expected_output == null
							? null
							: JSON.stringify(copy.expected_output),
						JSON.stringify(copy.metadata),
						copy.source_trace_id,
						copy.source_observation_id,
					],
				);
			}
			const config = experimentConfig(snapshot);
			const experiment = await client.query(
				"INSERT INTO experiments (id, project_id, agent_id, dataset_id, resolved_dataset_version_id, dataset_input_binding, name, config, status, requested_by_actor_id, evaluation_run_id) VALUES ($1,$2,NULL,$3,$4,'versioned',$5,$6::jsonb,'pending',$7,$8) RETURNING *",
				[
					experimentId,
					input.project_id,
					text(definitionRow, "dataset_id"),
					definition.dataset_version_id,
					`${text(definitionRow, "evaluation_name")} run v${input.definition_version}`,
					JSON.stringify(config),
					input.authorization.actor_id,
					runId,
				],
			);
			const experimentRow = experiment.rows[0] as Row | undefined;
			const benchmarkRunId = input.benchmark ? randomUUID() : null;
			if (input.benchmark) {
				await client.query(
					"INSERT INTO benchmark_runs (id, project_id, suite_id, experiment_id, evaluation_run_id, label, model, prompt_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
					[
						benchmarkRunId,
						input.project_id,
						input.benchmark.suite_id,
						experimentId,
						runId,
						input.benchmark.label,
						snapshot.target.model,
						input.benchmark.prompt_version ?? null,
					],
				);
			}
			if (input.gate) {
				const minimumPassRate = definition.thresholds.minimum_pass_rate;
				if (minimumPassRate === null)
					throw new EvaluationRunRepositoryError(
						"BAD_REQUEST",
						"An Evaluation Gate requires a pinned minimum pass rate",
					);
				await client.query(
					`INSERT INTO evaluation_gate_runs (
						id, organization_id, project_id, approval_id, evaluation_run_id,
						evaluation_id, definition_version_id, dataset_version_id,
						definition_content_hash, dataset_content_hash, target_fingerprint,
						evaluator_fingerprint, gate_context, minimum_pass_rate,
						requested_by_actor_id, idempotency_key
					) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
					[
						randomUUID(),
						input.authorization.organization_id,
						input.project_id,
						input.gate.approval_id,
						runId,
						text(definitionRow, "evaluation_id"),
						text(definitionRow, "id"),
						definition.dataset_version_id,
						text(definitionRow, "content_hash"),
						text(definitionRow, "dataset_content_hash"),
						snapshot.target_fingerprint,
						snapshot.evaluator_fingerprint,
						input.gate.gate_context,
						minimumPassRate,
						input.authorization.actor_id,
						input.idempotency_key,
					],
				);
				await client.query(
					`INSERT INTO evaluation_gate_audit_events (
						organization_id, project_id, approval_id, gate_run_id,
						evaluation_run_id, definition_version_id, actor_id,
						event_type, gate_context, outcome_status
					) SELECT $1, $2, $3, gate.id, $4, $5, $6, 'invoked', $7, 'pending'
					  FROM evaluation_gate_runs gate
					 WHERE gate.evaluation_run_id=$4 AND gate.project_id=$2`,
					[
						input.authorization.organization_id,
						input.project_id,
						input.gate.approval_id,
						runId,
						text(definitionRow, "id"),
						input.authorization.actor_id,
						input.gate.gate_context,
					],
				);
			}
			const finalRunRow = {
				...runRow,
				dataset_id: text(definitionRow, "dataset_id"),
				experiment_id: experimentRow?.id ?? experimentId,
				benchmark_run_id: benchmarkRunId,
				experiment_agent_id: nullableText(
					experimentRow ?? runRow,
					experimentRow ? "agent_id" : "experiment_agent_id",
				),
				experiment_name: nullableText(
					experimentRow ?? runRow,
					experimentRow ? "name" : "experiment_name",
				),
			};
			return runFromRow(finalRunRow, input, snapshot, false);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function getEvaluationRunStatus(
	db: Transactional,
	input: {
		id: string;
		project_id: string;
		authorization: ProjectAuthorization;
	},
): Promise<EvaluationRunLifecycleStatus> {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Evaluation Run is not available",
				);
			const policy = await approvedRedaction(
				client,
				input.authorization.organization_id,
				input.project_id,
			);
			return lifecycleStatusWithEvidence(
				client,
				input.id,
				input.project_id,
				EVIDENCE_MAX_ITEMS + 1,
				0,
				policyRedactionOptions(policy ?? { mode: "none", keys: [] }),
			);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function getEvaluationRunEvidence(
	db: Transactional,
	input: {
		id: string;
		project_id: string;
		limit?: number;
		offset?: number;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Evaluation Run is not available",
				);
			const offset = Math.max(0, input.offset ?? 0);
			const limit = Math.min(100, Math.max(1, input.limit ?? 100));
			const policy = await approvedRedaction(
				client,
				input.authorization.organization_id,
				input.project_id,
			);
			const status = await lifecycleStatusWithEvidence(
				client,
				input.id,
				input.project_id,
				limit,
				offset,
				policyRedactionOptions(policy ?? { mode: "none", keys: [] }),
			);
			const total = status.counts.total;
			return {
				run_id: status.id,
				project_id: status.project_id,
				items: status.items,
				total,
				next_offset:
					offset + status.items.length < total
						? offset + status.items.length
						: null,
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

const runSummaryQuery = `SELECT run.id, run.project_id, run.evaluation_id,
    run.definition_version_id, run.dataset_version_id, run.status,
    run.created_at, run.updated_at, run.terminal_reason,
    max(definition_version.content_hash) AS definition_content_hash,
    max(dataset_version.content_hash) AS dataset_content_hash,
    inputs.target_fingerprint, inputs.evaluator_fingerprint, inputs.sample_identity,
    inputs.evaluator_version, inputs.evaluator, inputs.execution_defaults,
    inputs.limits, inputs.execution_bounds, run.provider_call_count,
    count(task.id)::int AS total,
    count(task.id) FILTER (WHERE task.status = 'pending')::int AS pending,
    count(task.id) FILTER (WHERE task.status = 'running')::int AS running,
    count(task.id) FILTER (WHERE task.status = 'completed')::int AS completed,
    count(task.id) FILTER (WHERE task.status = 'failed')::int AS failed,
    count(task.id) FILTER (WHERE task.status = 'cancelled')::int AS cancelled,
    count(result.id)::int AS evaluated,
    count(result.id) FILTER (WHERE result.status = 'completed'
      AND EXISTS (SELECT 1 FROM jsonb_each_text(result.scores) score
                  WHERE score.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
                    AND score.value::numeric >= 1))::int AS passed,
    count(result.id) FILTER (WHERE result.status IS NULL OR result.status <> 'completed'
      OR NOT EXISTS (SELECT 1 FROM jsonb_each_text(result.scores) score
                    WHERE score.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
                      AND score.value::numeric >= 1))::int AS evaluated_failed,
    sum(result.cost_usd) AS cost_usd,
    sum(result.duration_ms)::int AS duration_ms,
    count(*) OVER ()::int AS total_count
 FROM evaluation_runs run
 JOIN evaluation_run_inputs inputs
   ON inputs.run_id=run.id AND inputs.project_id=run.project_id
 JOIN evaluation_definition_versions definition_version
   ON definition_version.id=run.definition_version_id
  AND definition_version.project_id=run.project_id
 JOIN dataset_versions dataset_version
   ON dataset_version.id=run.dataset_version_id
  AND dataset_version.project_id=run.project_id
 LEFT JOIN experiment_tasks task
   ON task.evaluation_run_id=run.id AND task.project_id=run.project_id
 LEFT JOIN experiment_results result
   ON result.experiment_id=task.experiment_id
  AND result.evaluation_run_id=run.id
  AND result.evaluation_run_item_id=task.evaluation_run_item_id
  AND result.project_id=run.project_id
 WHERE run.project_id=$1
   AND ($2::text IS NULL OR run.status=$2)
   AND ($3::uuid IS NULL OR run.evaluation_id=$3)
 GROUP BY run.id, inputs.target_fingerprint, inputs.evaluator_fingerprint,
    inputs.sample_identity, inputs.evaluator_version, inputs.evaluator,
    inputs.execution_defaults, inputs.limits, inputs.execution_bounds, run.provider_call_count
ORDER BY run.created_at DESC, run.id DESC
LIMIT $4 OFFSET $5`;

const runComparisonQuery = `SELECT run.id, run.project_id, run.evaluation_id,
    run.definition_version_id, run.dataset_version_id, run.status,
    run.created_at, run.updated_at, run.terminal_reason,
    max(definition_version.content_hash) AS definition_content_hash,
    max(dataset_version.content_hash) AS dataset_content_hash,
    inputs.target_fingerprint, inputs.evaluator_fingerprint, inputs.sample_identity,
    inputs.evaluator_version, inputs.evaluator, inputs.execution_defaults,
    inputs.limits, inputs.execution_bounds, run.provider_call_count,
    count(task.id)::int AS total,
    count(task.id) FILTER (WHERE task.status = 'pending')::int AS pending,
    count(task.id) FILTER (WHERE task.status = 'running')::int AS running,
    count(task.id) FILTER (WHERE task.status = 'completed')::int AS completed,
    count(task.id) FILTER (WHERE task.status = 'failed')::int AS failed,
    count(task.id) FILTER (WHERE task.status = 'cancelled')::int AS cancelled,
    count(result.id)::int AS evaluated,
    count(result.id) FILTER (WHERE result.status = 'completed'
      AND EXISTS (SELECT 1 FROM jsonb_each_text(result.scores) score
                  WHERE score.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
                    AND score.value::numeric >= 1))::int AS passed,
    count(result.id) FILTER (WHERE result.status IS NULL OR result.status <> 'completed'
      OR NOT EXISTS (SELECT 1 FROM jsonb_each_text(result.scores) score
                    WHERE score.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
                      AND score.value::numeric >= 1))::int AS evaluated_failed,
    sum(result.cost_usd) AS cost_usd,
    sum(result.duration_ms)::int AS duration_ms,
    count(*) OVER ()::int AS total_count
 FROM evaluation_runs run
 JOIN evaluation_run_inputs inputs
   ON inputs.run_id=run.id AND inputs.project_id=run.project_id
 JOIN evaluation_definition_versions definition_version
   ON definition_version.id=run.definition_version_id
  AND definition_version.project_id=run.project_id
 JOIN dataset_versions dataset_version
   ON dataset_version.id=run.dataset_version_id
  AND dataset_version.project_id=run.project_id
 LEFT JOIN experiment_tasks task
   ON task.evaluation_run_id=run.id AND task.project_id=run.project_id
 LEFT JOIN experiment_results result
   ON result.experiment_id=task.experiment_id
  AND result.evaluation_run_id=run.id
  AND result.evaluation_run_item_id=task.evaluation_run_item_id
  AND result.project_id=run.project_id
 WHERE run.project_id=$1
   AND run.id = ANY($2::uuid[])
 GROUP BY run.id, inputs.target_fingerprint, inputs.evaluator_fingerprint,
    inputs.sample_identity, inputs.evaluator_version, inputs.evaluator,
    inputs.execution_defaults, inputs.limits, inputs.execution_bounds, run.provider_call_count
 ORDER BY run.created_at DESC, run.id DESC`;

function metricsFromRow(row: Row) {
	const evaluated = Number(row.evaluated ?? 0);
	const passed = Number(row.passed ?? 0);
	const limits = object(row.limits ?? {}, "limits");
	const executionBounds = object(
		row.execution_bounds ?? {},
		"execution_bounds",
	) as EvaluationExecutionBounds;
	return {
		evaluated,
		passed,
		failed: Number(row.evaluated_failed ?? 0),
		pass_rate: evaluated > 0 ? passed / evaluated : null,
		cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
		provider_calls_used: Number(row.provider_call_count ?? 0),
		max_provider_calls: Number(executionBounds.max_provider_calls),
		max_cost_usd:
			limits.max_cost_usd == null ? null : Number(limits.max_cost_usd),
		duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
		max_duration_seconds:
			limits.max_duration_seconds == null
				? null
				: Number(limits.max_duration_seconds),
		score_counts: { passed, failed: Number(row.evaluated_failed ?? 0) },
	};
}

function summaryFromRow(row: Row) {
	return {
		id: text(row, "id"),
		project_id: text(row, "project_id"),
		evaluation_id: text(row, "evaluation_id"),
		definition_version_id: text(row, "definition_version_id"),
		dataset_version_id: text(row, "dataset_version_id"),
		status: text(row, "status") as EvaluationRun["status"],
		counts: {
			total: Number(row.total ?? 0),
			pending: Number(row.pending ?? 0),
			running: Number(row.running ?? 0),
			completed: Number(row.completed ?? 0),
			failed: Number(row.failed ?? 0),
			cancelled: Number(row.cancelled ?? 0),
		},
		metrics: metricsFromRow(row),
		target_fingerprint: text(row, "target_fingerprint"),
		evaluator_fingerprint: text(row, "evaluator_fingerprint"),
		sample_identity: text(row, "sample_identity"),
		created_at: timestamp(row, "created_at"),
		updated_at: timestamp(row, "updated_at"),
		terminal_reason: nullableText(row, "terminal_reason"),
	};
}

export async function listEvaluationRuns(
	db: Transactional,
	input: {
		project_id: string;
		status?: EvaluationRun["status"];
		evaluation_id?: string;
		limit?: number;
		offset?: number;
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Project is not available",
				);
			const result = await client.query(runSummaryQuery, [
				input.project_id,
				input.status ?? null,
				input.evaluation_id ?? null,
				Math.min(100, Math.max(1, input.limit ?? 50)),
				Math.max(0, input.offset ?? 0),
			]);
			return {
				items: result.rows.map((row) => summaryFromRow(row as Row)),
				total: result.rows[0]
					? Number((result.rows[0] as Row).total_count ?? result.rows.length)
					: 0,
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function compareEvaluationRuns(
	db: Transactional,
	input: {
		project_id: string;
		run_ids: [string, string];
		authorization: ProjectAuthorization;
	},
) {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Project is not available",
				);
			const result = await client.query(runComparisonQuery, [
				input.project_id,
				input.run_ids,
			]);
			if (result.rows.length !== 2)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Both Evaluation Runs must be available in this Project",
				);
			const rows = input.run_ids.map((id) =>
				result.rows.find((row) => text(row as Row, "id") === id),
			);
			if (rows.some((row) => !row))
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Both Evaluation Runs must be available in this Project",
				);
			const [left, right] = rows as [Row, Row];
			const differences: Array<{
				field:
					| "definition_version"
					| "dataset_version"
					| "target"
					| "evaluator"
					| "execution_defaults"
					| "sample"
					| "thresholds"
					| "terminal_reason"
					| "status";
				left: unknown;
				right: unknown;
			}> = [];
			const addDifference = (
				field: (typeof differences)[number]["field"],
				leftValue: unknown,
				rightValue: unknown,
			) => {
				if (canonical(leftValue) !== canonical(rightValue))
					differences.push({ field, left: leftValue, right: rightValue });
			};
			addDifference(
				"definition_version",
				{
					id: left.definition_version_id,
					content_hash: left.definition_content_hash,
				},
				{
					id: right.definition_version_id,
					content_hash: right.definition_content_hash,
				},
			);
			addDifference(
				"dataset_version",
				{
					id: left.dataset_version_id,
					content_hash: left.dataset_content_hash,
				},
				{
					id: right.dataset_version_id,
					content_hash: right.dataset_content_hash,
				},
			);
			addDifference(
				"target",
				left.target_fingerprint,
				right.target_fingerprint,
			);
			addDifference(
				"evaluator",
				left.evaluator_fingerprint,
				right.evaluator_fingerprint,
			);
			addDifference(
				"execution_defaults",
				left.execution_defaults,
				right.execution_defaults,
			);
			addDifference("sample", left.sample_identity, right.sample_identity);
			const snapshots = await client.query(
				"SELECT run_id, thresholds FROM evaluation_run_inputs WHERE project_id=$1 AND run_id = ANY($2::uuid[])",
				[input.project_id, input.run_ids],
			);
			const thresholdByRun = new Map(
				snapshots.rows.map((row) => [
					text(row as Row, "run_id"),
					row.thresholds,
				]),
			);
			addDifference(
				"thresholds",
				thresholdByRun.get(input.run_ids[0]),
				thresholdByRun.get(input.run_ids[1]),
			);
			addDifference("status", left.status, right.status);
			addDifference(
				"terminal_reason",
				left.terminal_reason,
				right.terminal_reason,
			);
			const leftMetrics = metricsFromRow(left);
			const rightMetrics = metricsFromRow(right);
			const inputDifferences = differences.filter(
				(difference) =>
					!new Set(["target", "status", "terminal_reason"]).has(
						difference.field,
					),
			);
			const unsupportedContract = [left, right].some(
				(row) =>
					row.evaluator_version === "legacy_untyped" || !row.evaluator_version,
			);
			const nonSuccess =
				left.status !== "completed" || right.status !== "completed";
			const refusal = unsupportedContract
				? {
						code: "unsupported_contract" as const,
						message: "At least one run uses an unsupported evaluator contract",
					}
				: nonSuccess
					? {
							code: "non_success_terminal" as const,
							message:
								"Both runs must complete before score, cost, or duration deltas are reported",
						}
					: inputDifferences.length > 0
						? {
								code: "incompatible_inputs" as const,
								message:
									"Runs have different pinned inputs; score or cost deltas are not an equivalent comparison",
							}
						: null;
			const comparable = refusal === null;
			return {
				run_ids: input.run_ids,
				comparable,
				differences,
				refusal,
				metrics: {
					left: leftMetrics,
					right: rightMetrics,
					delta: !comparable
						? null
						: {
								pass_rate:
									leftMetrics.pass_rate == null ||
									rightMetrics.pass_rate == null
										? null
										: rightMetrics.pass_rate - leftMetrics.pass_rate,
								cost_usd:
									leftMetrics.cost_usd == null || rightMetrics.cost_usd == null
										? null
										: rightMetrics.cost_usd - leftMetrics.cost_usd,
								duration_ms:
									leftMetrics.duration_ms == null ||
									rightMetrics.duration_ms == null
										? null
										: rightMetrics.duration_ms - leftMetrics.duration_ms,
							},
				},
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function getEvaluationRunExecution(
	db: Transactional,
	input: {
		id: string;
		project_id: string;
		authorization: ProjectAuthorization;
	},
): Promise<{
	id: string;
	project_id: string;
	experiment_id: string;
	dataset_id: string;
	config: Record<string, unknown>;
}> {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Evaluation Run is not available",
				);
			const result = await client.query(
				"SELECT run.id, run.project_id, version.dataset_id, experiment.id AS experiment_id, inputs.target, inputs.evaluator, inputs.execution_defaults, inputs.limits, inputs.execution_bounds FROM evaluation_runs run JOIN evaluation_run_inputs inputs ON inputs.run_id=run.id AND inputs.project_id=run.project_id JOIN dataset_versions version ON version.id=run.dataset_version_id AND version.project_id=run.project_id JOIN experiments experiment ON experiment.evaluation_run_id=run.id AND experiment.project_id=run.project_id WHERE run.id=$1 AND run.project_id=$2",
				[input.id, input.project_id],
			);
			const row = result.rows[0] as Row | undefined;
			if (!row)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Evaluation Run is not available",
				);
			const target = object(row.target, "target");
			return {
				id: text(row, "id"),
				project_id: text(row, "project_id"),
				experiment_id: text(row, "experiment_id"),
				dataset_id: text(row, "dataset_id"),
				config: {
					model: target.model,
					provider: target.provider,
					system_prompt: target.system_prompt,
					evaluator: object(row.evaluator, "evaluator").kind,
					...object(row.execution_defaults, "execution_defaults"),
					limits: object(row.limits ?? {}, "limits"),
					execution_bounds: object(
						row.execution_bounds ?? {},
						"execution_bounds",
					),
				},
			};
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function cancelEvaluationRun(
	db: Transactional,
	input: {
		id: string;
		project_id: string;
		authorization: ProjectAuthorization;
	},
): Promise<EvaluationRunLifecycleStatus> {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Evaluation Run is not available",
				);
			await client.query(
				"SELECT id FROM experiments WHERE evaluation_run_id=$1 AND project_id=$2 ORDER BY id FOR UPDATE",
				[input.id, input.project_id],
			);
			const run = await client.query(
				"SELECT * FROM evaluation_runs WHERE id=$1 AND project_id=$2 FOR UPDATE",
				[input.id, input.project_id],
			);
			if (!run.rows[0])
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Evaluation Run is not available",
				);
			const current = text(run.rows[0] as Row, "status");
			if (!(["pending", "running"] as string[]).includes(current))
				throw new EvaluationRunRepositoryError(
					"CONFLICT",
					`Evaluation Run is already ${current}`,
				);
			await client.query(
				"UPDATE evaluation_runs SET status='cancelled', terminal_reason='cancelled_by_request', updated_at=now() WHERE id=$1 AND project_id=$2",
				[input.id, input.project_id],
			);
			await client.query(
				"UPDATE experiments SET status='cancelled', updated_at=now() WHERE evaluation_run_id=$1 AND project_id=$2 AND status IN ('pending','running')",
				[input.id, input.project_id],
			);
			await client.query(
				"UPDATE experiment_tasks SET status='cancelled', cost_reservation_usd=NULL, lease_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL, completed_at=now(), last_error_classification='cancelled_by_request', last_error_message='evaluation run cancelled', updated_at=now() WHERE evaluation_run_id=$1 AND project_id=$2 AND status IN ('pending','running')",
				[input.id, input.project_id],
			);
			await client.query(
				"UPDATE execution_admissions SET status='cancelled', cancelled_at=now() WHERE project_id=$2 AND status='active' AND work_kind='experiment_task' AND work_id IN (SELECT id FROM experiment_tasks WHERE evaluation_run_id=$1 AND project_id=$2)",
				[input.id, input.project_id],
			);
			return lifecycleStatusWithEvidence(client, input.id, input.project_id);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function retryEvaluationRun(
	db: Transactional,
	input: {
		id: string;
		project_id: string;
		authorization: ProjectAuthorization;
	},
): Promise<EvaluationRunLifecycleStatus> {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Evaluation Run is not available",
				);
			await client.query(
				"SELECT id FROM experiments WHERE evaluation_run_id=$1 AND project_id=$2 ORDER BY id FOR UPDATE",
				[input.id, input.project_id],
			);
			const run = await client.query(
				"SELECT * FROM evaluation_runs WHERE id=$1 AND project_id=$2 FOR UPDATE",
				[input.id, input.project_id],
			);
			if (!run.rows[0])
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Evaluation Run is not available",
				);
			if (text(run.rows[0] as Row, "status") !== "failed")
				throw new EvaluationRunRepositoryError(
					"CONFLICT",
					"Only failed Evaluation Runs can be retried",
				);
			const reset = await client.query(
				"UPDATE experiment_tasks SET status='pending', next_attempt_at=now(), lease_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL, last_error_classification=NULL, last_error_message=NULL, updated_at=now() WHERE evaluation_run_id=$1 AND project_id=$2 AND status='failed' AND attempt_count < max_attempts AND last_error_classification = 'provider_error' RETURNING id",
				[input.id, input.project_id],
			);
			if (!reset.rows.length)
				throw new EvaluationRunRepositoryError(
					"CONFLICT",
					"Evaluation Run has no retryable failed items",
				);
			const boundsResult = await client.query(
				"SELECT execution_bounds FROM evaluation_run_inputs WHERE run_id=$1 AND project_id=$2 FOR UPDATE",
				[input.id, input.project_id],
			);
			const boundsRow = boundsResult.rows[0] as Row | undefined;
			if (!boundsRow)
				throw new EvaluationRunRepositoryError(
					"INTERNAL",
					"Evaluation Run execution bounds are unavailable",
				);
			const bounds = object(
				boundsRow.execution_bounds,
				"execution_bounds",
			) as EvaluationExecutionBounds;
			await assertEvaluationRunCapacity(client, {
				project_id: input.project_id,
				actor_id: text(run.rows[0] as Row, "requested_by_actor_id"),
				bounds,
			});
			await activateEvaluationRunCapacity(client, {
				run_id: input.id,
				organization_id: input.authorization.organization_id,
				project_id: input.project_id,
				actor_id: text(run.rows[0] as Row, "requested_by_actor_id"),
			});
			await client.query(
				"UPDATE evaluation_runs SET status='running', terminal_reason=NULL, updated_at=now() WHERE id=$1 AND project_id=$2",
				[input.id, input.project_id],
			);
			await client.query(
				"UPDATE experiments SET status='running', updated_at=now() WHERE evaluation_run_id=$1 AND project_id=$2 AND status='failed'",
				[input.id, input.project_id],
			);
			return lifecycleStatusWithEvidence(client, input.id, input.project_id);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}

export async function listEvaluationRunEvents(
	db: Transactional,
	input: {
		id: string;
		project_id: string;
		after_id: number;
		authorization: ProjectAuthorization;
	},
): Promise<EvaluationRunLifecycleEvent[]> {
	try {
		return await withTransaction(db, async (client) => {
			if (
				!(await lockActiveAuthorizedProject(
					client,
					input.project_id,
					input.authorization,
				))
			)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Evaluation Run is not available",
				);
			const result = await client.query(
				"SELECT id, run_id, event_type, task_id, payload, created_at FROM evaluation_run_events WHERE run_id=$1 AND project_id=$2 AND id>$3 ORDER BY id ASC LIMIT 100",
				[input.id, input.project_id, input.after_id],
			);
			return (result.rows as Row[]).map((row) => ({
				id: Number(row.id),
				run_id: text(row, "run_id"),
				event_type: text(
					row,
					"event_type",
				) as EvaluationRunLifecycleEvent["event_type"],
				task_id: nullableText(row, "task_id"),
				payload: object(row.payload, "payload"),
				created_at: timestamp(row, "created_at"),
			}));
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
