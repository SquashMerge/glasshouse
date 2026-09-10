import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { EvaluationDefinitionInput } from "../schemas/evaluations.js";
import {
	lockActiveAuthorizedProject,
	type ProjectAuthorization,
} from "./project-authorization.js";

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
		model?: string | null;
		prompt_version?: string | null;
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
	execution_defaults: Record<string, unknown>;
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

export class EvaluationRunRepositoryError extends Error {
	readonly status: 400 | 404 | 409 | 500;
	constructor(
		readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "INTERNAL",
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
						: 500;
	}
}

function normalize(cause: unknown): EvaluationRunRepositoryError {
	if (cause instanceof EvaluationRunRepositoryError) return cause;
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

function snapshotFor(
	definition: ReturnType<typeof definitionFields>,
	items: Row[],
): ResolvedSnapshot {
	const model =
		typeof definition.target.model === "string" && definition.target.model
			? definition.target.model
			: (process.env.OPENAI_MODEL ?? "gpt-4o-mini");
	const target = { ...definition.target, model };
	const evaluator = { ...definition.evaluator };
	const executionDefaults = { ...definition.execution_defaults };
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
		execution_defaults: executionDefaults,
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
		system_prompt: snapshot.target.system_prompt,
		evaluator: snapshot.evaluator.kind,
		temperature: snapshot.execution_defaults.temperature,
		max_tokens: snapshot.execution_defaults.max_tokens,
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

function admittedItemSnapshot(item: Row) {
	return {
		dataset_version_item_id: text(item, "dataset_version_item_id"),
		item_key: text(item, "item_key"),
		position: Number(item.position),
		input: object(item.input, "input"),
		expected_output: item.expected_output ?? null,
		metadata: object(item.metadata ?? {}, "metadata"),
		source_trace_id: item.source_trace_id ?? null,
		source_observation_id: item.source_observation_id ?? null,
	};
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
				"SELECT run.*, experiment.id AS experiment_id, benchmark.id AS benchmark_run_id, version.dataset_id FROM evaluation_runs run LEFT JOIN experiments experiment ON experiment.evaluation_run_id = run.id AND experiment.project_id = run.project_id LEFT JOIN benchmark_runs benchmark ON benchmark.evaluation_run_id = run.id AND benchmark.project_id = run.project_id JOIN dataset_versions version ON version.id = run.dataset_version_id AND version.project_id = run.project_id WHERE run.project_id=$1 AND run.idempotency_key=$2",
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
				const itemRows = await client.query(
					"SELECT item.* FROM evaluation_run_items item WHERE item.run_id=$1 AND item.project_id=$2 ORDER BY item.position ASC, item.item_key ASC, item.id ASC",
					[text(row, "id"), input.project_id],
				);
				const snapshotRow = snapshotRows.rows[0] as Row | undefined;
				const snapshot = snapshotRow
					? ({
							target: object(snapshotRow.target, "target"),
							target_version: text(snapshotRow, "target_version"),
							target_fingerprint: text(snapshotRow, "target_fingerprint"),
							evaluator: object(snapshotRow.evaluator, "evaluator"),
							evaluator_version: text(snapshotRow, "evaluator_version"),
							execution_defaults: object(
								snapshotRow.execution_defaults,
								"execution_defaults",
							),
							thresholds: object(snapshotRow.thresholds, "thresholds"),
							sampling: object(snapshotRow.sampling, "sampling"),
							sample_identity: text(snapshotRow, "sample_identity"),
							ordered_item_snapshot: itemRows.rows.map(admittedItemSnapshot),
							resolved_inputs_hash: text(snapshotRow, "resolved_inputs_hash"),
						} satisfies ResolvedSnapshot)
					: ({
							target: {},
							target_version: "unknown",
							target_fingerprint: "",
							evaluator: {},
							evaluator_version: "unknown",
							execution_defaults: {},
							thresholds: {},
							sampling: {},
							sample_identity: "",
							ordered_item_snapshot: itemRows.rows,
							resolved_inputs_hash: text(row, "resolved_inputs_hash"),
						} satisfies ResolvedSnapshot);
				return runFromRow(row, input, snapshot, true);
			}

			const definitionResult = await client.query(
				`SELECT definition.*, evaluation.name AS evaluation_name, dataset_version.dataset_id
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
				 FOR UPDATE OF definition, evaluation, dataset_version, dataset`,
				[
					input.project_id,
					input.evaluation_selector,
					input.definition_version,
					input.expected_dataset_id ?? null,
					input.benchmark?.suite_id ?? null,
				],
			);
			const definitionRow = definitionResult.rows[0] as Row | undefined;
			if (!definitionRow)
				throw new EvaluationRunRepositoryError(
					"NOT_FOUND",
					"Executable Evaluation Definition Version is not available",
				);
			const definition = definitionFields(definitionRow);
			const itemResult = await client.query(
				"SELECT item.* FROM dataset_version_items item WHERE item.project_id=$1 AND item.dataset_version_id=$2 ORDER BY item.position ASC, item.item_key ASC, item.id ASC",
				[input.project_id, definition.dataset_version_id],
			);
			const allItems = itemResult.rows as Row[];
			if (allItems.length === 0)
				throw new EvaluationRunRepositoryError(
					"BAD_REQUEST",
					"The selected Dataset Version contains no items",
				);
			const requestedSampleSize = Number(definition.sampling.sample_size);
			const selectedItems = allItems.slice(0, requestedSampleSize);
			if (selectedItems.some((item) => item.expected_output == null))
				throw new EvaluationRunRepositoryError(
					"BAD_REQUEST",
					"Every selected Dataset Version item needs expected output",
				);
			const snapshot = snapshotFor(definition, selectedItems);
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
				"INSERT INTO evaluation_run_inputs (run_id, organization_id, project_id, target, target_version, target_fingerprint, evaluator, evaluator_version, execution_defaults, thresholds, sampling, sample_identity, ordered_item_snapshot, resolved_inputs_hash) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13::jsonb,$14)",
				[
					runId,
					input.authorization.organization_id,
					input.project_id,
					JSON.stringify(snapshot.target),
					snapshot.target_version,
					snapshot.target_fingerprint,
					JSON.stringify(snapshot.evaluator),
					snapshot.evaluator_version,
					JSON.stringify(snapshot.execution_defaults),
					JSON.stringify(snapshot.thresholds),
					JSON.stringify(snapshot.sampling),
					snapshot.sample_identity,
					JSON.stringify(snapshot.ordered_item_snapshot),
					snapshot.resolved_inputs_hash,
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
						input.benchmark.model ?? snapshot.target.model,
						input.benchmark.prompt_version ?? null,
					],
				);
			}
			const finalRunRow = {
				...runRow,
				dataset_id: text(definitionRow, "dataset_id"),
				experiment_id:
					(experiment.rows[0] as Row | undefined)?.id ?? experimentId,
				benchmark_run_id: benchmarkRunId,
			};
			return runFromRow(finalRunRow, input, snapshot, false);
		});
	} catch (cause) {
		throw normalize(cause);
	}
}
