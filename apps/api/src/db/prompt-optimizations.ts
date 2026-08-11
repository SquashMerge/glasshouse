import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	hashOptimizationDataset,
	type OptimizationDataset,
	type OptimizationEvidence,
	type OptimizationExample,
	type OptimizationPromotionStatus,
	type StoredOptimizationDataset,
} from "../lib/optimization-dataset.js";
import type { JsonObject, PromptMessage, PromptRole } from "./prompts.js";
import { PromptRepositoryError } from "./prompts.js";
import {
	lockActiveAuthorizedProject,
	type ProjectAuthorization,
} from "./project-authorization.js";
import {
	createExecutionAdmission,
	claimExecutionAdmission,
	executionAdmissionIsActive,
	type ExecutionAdmissionEffect,
	type ExecutionAdmission,
} from "./execution-admissions.js";

export type OptimizationStatus =
	| "queued"
	| "preparing"
	| "optimizing"
	| "evaluating"
	| "completed"
	| "stopped"
	| "failed";

export type OptimizationJob = {
	id: string;
	project_id: string;
	prompt_id: string;
	prompt_slug: string;
	source_version: number;
	target: PromptRole;
	evaluator: JsonObject;
	dataset: StoredOptimizationDataset;
	dataset_hash: string;
	model_config: JsonObject;
	budget: JsonObject;
	status: OptimizationStatus;
	requested_by: string;
	result_version: number | null;
	candidate_content: string | null;
	evidence: OptimizationEvidence | null;
	promotion_status: OptimizationPromotionStatus;
	promotion_reason: string | null;
	reviewed_by: string | null;
	promoted_at: string | null;
	error_message: string | null;
	metric_calls_used: number | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
};
export type OptimizationActivity = Pick<
	OptimizationJob,
	| "id"
	| "prompt_slug"
	| "source_version"
	| "target"
	| "status"
	| "created_at"
	| "updated_at"
>;
export type OptimizationEvent = {
	id: number;
	status: OptimizationStatus;
	detail: JsonObject;
	created_at: string;
};

type Row = Record<string, unknown>;

function fail(
	code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "INTERNAL",
	message: string,
): PromptRepositoryError {
	return new PromptRepositoryError(code, message);
}

function object(value: unknown, name: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw fail("INTERNAL", `Invalid ${name}`);
	return value as JsonObject;
}

function json(value: unknown, name: string): JsonObject {
	return typeof value === "string"
		? object(JSON.parse(value), name)
		: object(value, name);
}

function time(value: unknown): string {
	return value instanceof Date
		? value.toISOString()
		: typeof value === "string"
			? value
			: (() => {
					throw fail("INTERNAL", "Invalid timestamp");
				})();
}

function nullableTime(value: unknown): string | null {
	return value === null || value === undefined ? null : time(value);
}

function status(value: unknown): OptimizationStatus {
	if (
		[
			"queued",
			"preparing",
			"optimizing",
			"evaluating",
			"completed",
			"stopped",
			"failed",
		].includes(String(value))
	)
		return value as OptimizationStatus;
	throw fail("INTERNAL", "Invalid optimization status");
}

function promotionStatus(value: unknown): OptimizationPromotionStatus {
	if (
		[
			"pending",
			"auto_promoted",
			"review_required",
			"blocked",
			"reviewed_promoted",
			"legacy",
		].includes(String(value))
	)
		return value as OptimizationPromotionStatus;
	throw fail("INTERNAL", "Invalid optimization promotion status");
}

function number(value: unknown, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw fail("INTERNAL", `Invalid ${name}`);
	return parsed;
}
function nullableNonNegativeNumber(
	value: unknown,
	name: string,
): number | null {
	if (value === null || value === undefined) return null;
	const parsed = number(value, name);
	if (parsed < 0) throw fail("INTERNAL", `Invalid ${name}`);
	return parsed;
}
function score(value: unknown, name: string): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value))
		throw fail("INTERNAL", `Invalid ${name}`);
	return value;
}
function messages(value: unknown): PromptMessage[] {
	const parsed = typeof value === "string" ? JSON.parse(value) : value;
	if (!Array.isArray(parsed)) throw fail("INTERNAL", "Invalid source messages");
	return parsed as PromptMessage[];
}

function examples(value: unknown, name: string): OptimizationExample[] {
	if (!Array.isArray(value)) throw fail("INTERNAL", `Invalid ${name}`);
	return value.map((item) => {
		const example = object(item, name);
		if (typeof example.input !== "string" || typeof example.answer !== "string")
			throw fail("INTERNAL", `Invalid ${name}`);
		if (
			example.additional_context !== undefined &&
			(example.additional_context === null ||
				typeof example.additional_context !== "object" ||
				Array.isArray(example.additional_context))
		)
			throw fail("INTERNAL", `Invalid ${name}`);
		return {
			input: example.input,
			answer: example.answer,
			...(example.additional_context === undefined
				? {}
				: { additional_context: example.additional_context as JsonObject }),
		};
	});
}

function dataset(value: unknown): StoredOptimizationDataset {
	const parsed = json(value, "dataset");
	if (parsed.version !== 0 && parsed.version !== 1)
		throw fail("INTERNAL", "Invalid dataset version");
	if (typeof parsed.rubric !== "string")
		throw fail("INTERNAL", "Invalid dataset rubric");
	const training_examples = examples(
		parsed.training_examples,
		"training examples",
	);
	const validation_examples = examples(
		parsed.validation_examples,
		"validation examples",
	);
	return {
		version: parsed.version,
		rubric: parsed.rubric,
		training_examples,
		validation_examples,
	} as StoredOptimizationDataset;
}

function evidence(value: unknown): OptimizationEvidence | null {
	if (value === null || value === undefined) return null;
	const parsed = json(value, "optimization evidence");
	if (Object.keys(parsed).length === 0) return null;
	if (
		parsed.metric !== "default_adapter.expected_answer_contains" ||
		typeof parsed.rubric !== "string"
	)
		throw fail("INTERNAL", "Invalid optimization evidence");
	const training = object(parsed.training, "training evidence");
	const validation = object(parsed.validation, "validation evidence");
	const leakage = object(parsed.leakage, "leakage evidence");
	if (
		!Number.isSafeInteger(training.sample_count) ||
		!Number.isSafeInteger(validation.sample_count) ||
		validation.held_out !== true ||
		!["not_run", "passed", "failed"].includes(String(leakage.status)) ||
		(leakage.reason !== null &&
			leakage.reason !== "expected_answer_full_match" &&
			leakage.reason !== "expected_answer_material_span")
	)
		throw fail("INTERNAL", "Invalid optimization evidence");
	return {
		metric: "default_adapter.expected_answer_contains",
		rubric: parsed.rubric,
		training: {
			sample_count: Number(training.sample_count),
			score: score(training.score, "training score"),
		},
		validation: {
			sample_count: Number(validation.sample_count),
			score: score(validation.score, "validation score"),
			baseline_score: score(
				validation.baseline_score,
				"baseline validation score",
			),
			held_out: true,
		},
		leakage: {
			status: leakage.status as OptimizationEvidence["leakage"]["status"],
			reason: leakage.reason as OptimizationEvidence["leakage"]["reason"],
		},
	};
}

function mapJob(row: Row): OptimizationJob {
	return {
		id: String(row.id),
		project_id: String(row.project_id),
		prompt_id: String(row.prompt_id),
		prompt_slug: String(row.prompt_slug),
		source_version: number(row.source_version, "source version"),
		target: row.target_role as PromptRole,
		evaluator: json(row.evaluator, "evaluator"),
		dataset: dataset(row.dataset),
		dataset_hash: String(row.dataset_hash),
		model_config: json(row.model_config, "model config"),
		budget: json(row.budget, "budget"),
		status: status(row.status),
		requested_by: String(row.requested_by),
		result_version:
			row.result_version === null
				? null
				: number(row.result_version, "result version"),
		candidate_content:
			row.candidate_content === null || row.candidate_content === undefined
				? null
				: String(row.candidate_content),
		evidence: evidence(row.evidence),
		promotion_status: promotionStatus(row.promotion_status),
		promotion_reason:
			row.promotion_reason === null || row.promotion_reason === undefined
				? null
				: String(row.promotion_reason),
		reviewed_by:
			row.reviewed_by === null || row.reviewed_by === undefined
				? null
				: String(row.reviewed_by),
		promoted_at: nullableTime(row.promoted_at),
		error_message:
			row.error_message === null ? null : String(row.error_message),
		metric_calls_used: nullableNonNegativeNumber(
			row.metric_calls_used,
			"metric calls used",
		),
		created_at: time(row.created_at),
		updated_at: time(row.updated_at),
		completed_at: nullableTime(row.completed_at),
	};
}

async function rows(
	client: Pick<Pool, "query"> | PoolClient,
	text: string,
	values: unknown[] = [],
): Promise<Row[]> {
	return (await client.query(text, values)).rows as Row[];
}

async function tx<T>(
	pool: Pick<Pool, "connect">,
	fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await fn(client);
		await client.query("COMMIT");
		return result;
	} catch (cause) {
		await client.query("ROLLBACK");
		throw cause;
	} finally {
		client.release();
	}
}

async function lockOptimizationExecution(
	client: PoolClient,
	id: string,
): Promise<{
	job: Row;
	project_id: string;
	organization_id: string;
	requester_actor_id: string;
} | null> {
	const project = await client.query<{
		id: string;
		organization_id: string;
	}>(
		"SELECT p.id, p.organization_id FROM projects p JOIN prompt_optimization_jobs j ON j.project_id = p.id WHERE j.id = $1 AND p.status = 'active'",
		[id],
	);
	if (!project.rows[0]) return null;
	const identity = await client.query<{ actor_id: string }>(
		"SELECT actor_id FROM actor_identities AS identity JOIN prompt_optimization_jobs AS job ON job.id = $2 WHERE identity.organization_id = $1 AND identity.provider_namespace = 'basic:v1' AND identity.canonical_subject = basic_auth_canonical_subject(job.requested_by)",
		[project.rows[0].organization_id, id],
	);
	if (!identity.rows[0]) return null;
	if (
		!(await lockActiveAuthorizedProject(client, project.rows[0].id, {
			organization_id: project.rows[0].organization_id,
			actor_id: identity.rows[0].actor_id,
			operation: "execute",
		}))
	)
		return null;
	const job = await rows(
		client,
		"SELECT * FROM prompt_optimization_jobs WHERE id = $1 FOR UPDATE",
		[id],
	);
	if (!job[0]) return null;
	return {
		job: job[0],
		project_id: project.rows[0].id,
		organization_id: project.rows[0].organization_id,
		requester_actor_id: identity.rows[0].actor_id,
	};
}

export async function admitOptimizationExecution(
	pool: Pick<Pool, "connect">,
	input: { id: string; worker_id: string; timeout_ms: number },
): Promise<ExecutionAdmission | null> {
	return tx(pool, async (client) => {
		const execution = await lockOptimizationExecution(client, input.id);
		if (!execution) return null;
		const admitted = await rows(
			client,
			"SELECT id FROM prompt_optimization_jobs WHERE id = $1 AND worker_claim_id = $2 AND worker_lease_expires_at >= now() AND status = 'optimizing' FOR UPDATE",
			[input.id, input.worker_id],
		);
		if (!admitted.length) return null;
		return createExecutionAdmission(client, {
			organization_id: execution.organization_id,
			project_id: execution.project_id,
			requester_actor_id: execution.requester_actor_id,
			work_kind: "optimization",
			work_id: input.id,
			timeout_ms: input.timeout_ms,
		});
	});
}

export async function optimizationExecutionAdmissionIsActive(
	pool: Pick<Pool, "connect">,
	input: { id: string; worker_id: string; admission_id: string },
): Promise<boolean> {
	return tx(pool, async (client) => {
		const execution = await lockOptimizationExecution(client, input.id);
		if (!execution) return false;
		const claimed = await rows(
			client,
			"SELECT id FROM prompt_optimization_jobs WHERE id = $1 AND worker_claim_id = $2 AND worker_lease_expires_at >= now() AND status IN ('optimizing', 'evaluating') FOR UPDATE",
			[input.id, input.worker_id],
		);
		if (!claimed.length) return false;
		return executionAdmissionIsActive(client, {
			id: input.admission_id,
			project_id: execution.project_id,
		});
	});
}

export async function claimOptimizationExecution(
	pool: Pick<Pool, "connect">,
	input: {
		id: string;
		worker_id: string;
		admission_id: string;
		effect: ExecutionAdmissionEffect;
	},
): Promise<boolean> {
	return tx(pool, async (client) => {
		const execution = await lockOptimizationExecution(client, input.id);
		if (!execution) return false;
		const claimed = await rows(
			client,
			"SELECT id FROM prompt_optimization_jobs WHERE id = $1 AND worker_claim_id = $2 AND worker_lease_expires_at >= now() AND status IN ('optimizing', 'evaluating') FOR UPDATE",
			[input.id, input.worker_id],
		);
		if (!claimed.length) return false;
		return claimExecutionAdmission(client, {
			id: input.admission_id,
			project_id: execution.project_id,
			effect: input.effect,
		});
	});
}

function resultEventDetail(input: {
	result_version?: number;
	evidence: OptimizationEvidence;
	promotion_status: OptimizationPromotionStatus;
	promotion_reason: string | null;
	reviewed_by?: string;
	metric_calls_used?: number | null;
}): JsonObject {
	return {
		...(input.result_version === undefined
			? {}
			: { result_version: input.result_version }),
		metric: input.evidence.metric,
		training: input.evidence.training,
		validation: input.evidence.validation,
		leakage: input.evidence.leakage,
		promotion_status: input.promotion_status,
		...(input.promotion_reason === null
			? {}
			: { promotion_reason: input.promotion_reason }),
		...(input.reviewed_by === undefined
			? {}
			: { reviewed_by: input.reviewed_by }),
		...(input.metric_calls_used === null ||
		input.metric_calls_used === undefined
			? {}
			: { metric_calls_used: input.metric_calls_used }),
	};
}

export async function createOptimizationJob(
	pool: Pick<Pool, "connect">,
	input: {
		project_id: string;
		slug: string;
		source_version: number;
		target: PromptRole;
		evaluator: JsonObject;
		dataset: OptimizationDataset;
		model_config: JsonObject;
		budget: JsonObject;
		actor: string;
		authorization: ProjectAuthorization;
	},
): Promise<OptimizationJob> {
	if (!input.dataset.training_examples.length)
		throw fail("BAD_REQUEST", "training examples must not be empty");
	if (!input.dataset.validation_examples.length)
		throw fail("BAD_REQUEST", "validation examples must not be empty");
	const datasetHash = hashOptimizationDataset(input.dataset);
	return tx(pool, async (client) => {
		if (
			!(await lockActiveAuthorizedProject(
				client,
				input.project_id,
				input.authorization,
			))
		)
			throw fail("NOT_FOUND", "Project is not available");
		const source = (
			await rows(
				client,
				`SELECT p.id AS prompt_id, v.messages FROM prompts p JOIN prompt_versions v ON v.prompt_id = p.id WHERE p.project_id = $1 AND p.slug = $2 AND v.version = $3 FOR SHARE`,
				[input.project_id, input.slug, input.source_version],
			)
		)[0];
		if (!source) throw fail("NOT_FOUND", "Prompt or version not found");
		if (
			!messages(source.messages).some(
				(message) => message.role === input.target,
			)
		)
			throw fail("BAD_REQUEST", `Source prompt has no ${input.target} message`);
		const id = randomUUID();
		const inserted = (
			await rows(
				client,
				`INSERT INTO prompt_optimization_jobs (id, project_id, prompt_id, prompt_slug, source_version, target_role, source_messages, evaluator, examples, dataset, dataset_hash, model_config, budget, status, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13::jsonb,'queued',$14) ON CONFLICT (project_id, prompt_id, source_version, target_role) WHERE status IN ('queued', 'preparing', 'optimizing', 'evaluating') DO UPDATE SET updated_at=prompt_optimization_jobs.updated_at RETURNING *, (xmax = 0) AS created`,
				[
					id,
					input.project_id,
					source.prompt_id,
					input.slug,
					input.source_version,
					input.target,
					JSON.stringify(messages(source.messages)),
					JSON.stringify(input.evaluator),
					JSON.stringify(input.dataset.training_examples),
					JSON.stringify(input.dataset),
					datasetHash,
					JSON.stringify(input.model_config),
					JSON.stringify(input.budget),
					input.actor,
				],
			)
		)[0];
		if (!inserted) throw fail("INTERNAL", "Optimization job insert failed");
		if (inserted.created)
			await rows(
				client,
				"INSERT INTO prompt_optimization_events (job_id, status, detail) VALUES ($1, 'queued', $2::jsonb)",
				[
					id,
					JSON.stringify({
						target: input.target,
						source_version: input.source_version,
						dataset_version: input.dataset.version,
						training_sample_count: input.dataset.training_examples.length,
						validation_sample_count: input.dataset.validation_examples.length,
						max_metric_calls: input.budget.max_metric_calls,
					}),
				],
			);
		return mapJob(inserted);
	});
}

export async function getOptimizationJob(
	pool: Pick<Pool, "query">,
	input: { project_id: string; id: string },
): Promise<OptimizationJob> {
	const row = (
		await rows(
			pool,
			"SELECT j.* FROM prompt_optimization_jobs j JOIN projects p ON p.id = j.project_id AND p.status = 'active' WHERE j.project_id = $1 AND j.id = $2",
			[input.project_id, input.id],
		)
	)[0];
	if (!row) throw fail("NOT_FOUND", "Optimization job not found");
	return mapJob(row);
}

export async function getActiveOptimizationJob(
	pool: Pick<Pool, "query">,
	input: { project_id: string; slug: string },
): Promise<OptimizationJob | null> {
	const row = (
		await rows(
			pool,
			"SELECT j.* FROM prompt_optimization_jobs j JOIN projects p ON p.id = j.project_id AND p.status = 'active' WHERE j.project_id=$1 AND j.prompt_slug=$2 AND (j.status IN ('queued','preparing','optimizing','evaluating') OR j.promotion_status='review_required') ORDER BY CASE WHEN j.status IN ('queued','preparing','optimizing','evaluating') THEN 0 ELSE 1 END, j.updated_at DESC, j.id DESC LIMIT 1",
			[input.project_id, input.slug],
		)
	)[0];
	return row ? mapJob(row) : null;
}
export async function getLatestOptimizationJob(
	pool: Pick<Pool, "query">,
	input: { project_id: string; slug: string },
): Promise<OptimizationJob | null> {
	const row = (
		await rows(
			pool,
			"SELECT j.* FROM prompt_optimization_jobs j JOIN projects p ON p.id = j.project_id AND p.status = 'active' WHERE j.project_id=$1 AND j.prompt_slug=$2 ORDER BY CASE WHEN j.status IN ('queued','preparing','optimizing','evaluating') THEN 0 ELSE 1 END, j.updated_at DESC, j.id DESC LIMIT 1",
			[input.project_id, input.slug],
		)
	)[0];
	return row ? mapJob(row) : null;
}
export async function listActiveOptimizationActivities(
	pool: Pick<Pool, "query">,
	input: { project_id: string },
): Promise<OptimizationActivity[]> {
	return (
		await rows(
			pool,
			"SELECT DISTINCT ON (j.prompt_id) j.* FROM prompt_optimization_jobs j JOIN projects p ON p.id = j.project_id AND p.status = 'active' WHERE j.project_id=$1 AND j.status IN ('queued','preparing','optimizing','evaluating') ORDER BY j.prompt_id, j.updated_at DESC, j.id DESC",
			[input.project_id],
		)
	).map((row) => {
		const job = mapJob(row);
		return {
			id: job.id,
			prompt_slug: job.prompt_slug,
			source_version: job.source_version,
			target: job.target,
			status: job.status,
			created_at: job.created_at,
			updated_at: job.updated_at,
		};
	});
}
export async function claimOptimizationJob(
	pool: Pick<Pool, "connect">,
	input: { id: string; worker_id: string },
): Promise<boolean> {
	return tx(pool, async (client) => {
		if (!(await lockOptimizationExecution(client, input.id))) return false;
		const claimed = await rows(
			client,
			"UPDATE prompt_optimization_jobs SET worker_claim_id=$2,worker_claimed_at=now(),worker_lease_expires_at=now() + interval '5 minutes',updated_at=now() WHERE id=$1 AND status IN ('queued','preparing','optimizing','evaluating') AND (worker_claim_id IS NULL OR worker_lease_expires_at IS NULL OR worker_lease_expires_at < now()) RETURNING id",
			[input.id, input.worker_id],
		);
		return claimed.length === 1;
	});
}

export async function renewOptimizationJobLease(
	pool: Pick<Pool, "connect">,
	input: { id: string; worker_id: string },
): Promise<boolean> {
	return tx(pool, async (client) => {
		if (!(await lockOptimizationExecution(client, input.id))) return false;
		const renewed = await rows(
			client,
			"UPDATE prompt_optimization_jobs SET worker_lease_expires_at=now() + interval '5 minutes',updated_at=now() WHERE id=$1 AND worker_claim_id=$2 AND worker_lease_expires_at >= now() AND status IN ('queued','preparing','optimizing','evaluating') RETURNING id",
			[input.id, input.worker_id],
		);
		return renewed.length === 1;
	});
}
export async function recordOptimizationMetricCalls(
	pool: Pick<Pool, "connect">,
	input: {
		id: string;
		worker_id: string;
		metric_calls_used: number;
		admission_id?: string;
	},
): Promise<void> {
	await tx(pool, async (client) => {
		const execution = await lockOptimizationExecution(client, input.id);
		if (!execution)
			throw fail("CONFLICT", "Optimization worker claim was lost");
		if (
			input.admission_id &&
			!(await claimExecutionAdmission(client, {
				id: input.admission_id,
				project_id: execution.project_id,
				effect: "metric_write",
			}))
		)
			throw fail("CONFLICT", "Optimization execution admission was cancelled");
		const recorded = await rows(
			client,
			"UPDATE prompt_optimization_jobs SET metric_calls_used=GREATEST(COALESCE(metric_calls_used,0),$3),updated_at=now() WHERE id=$1 AND worker_claim_id=$2 AND worker_lease_expires_at >= now() RETURNING id",
			[input.id, input.worker_id, input.metric_calls_used],
		);
		if (!recorded.length)
			throw fail("CONFLICT", "Optimization worker claim was lost");
	});
}
export async function failInterruptedOptimizationJobs(
	pool: Pick<Pool, "query">,
): Promise<Array<{ id: string; project_id: string }>> {
	const failed = await rows(
		pool,
		"UPDATE prompt_optimization_jobs j SET status='failed', error_message='Interrupted by API restart', updated_at=now(), completed_at=now() FROM projects p WHERE p.id=j.project_id AND p.status = 'active' AND j.status IN ('queued','preparing','optimizing','evaluating') RETURNING j.id, j.project_id",
	);
	return failed.map((row) => ({
		id: String(row.id),
		project_id: String(row.project_id),
	}));
}

export async function optimizationSourceMessages(
	pool: Pick<Pool, "query">,
	input: { project_id: string; id: string },
): Promise<PromptMessage[]> {
	const row = (
		await rows(
			pool,
			"SELECT j.source_messages FROM prompt_optimization_jobs j JOIN projects p ON p.id = j.project_id AND p.status = 'active' WHERE j.project_id=$1 AND j.id=$2",
			[input.project_id, input.id],
		)
	)[0];
	if (!row) throw fail("NOT_FOUND", "Optimization job not found");
	return messages(row.source_messages);
}

export async function listOptimizationEvents(
	pool: Pick<Pool, "query">,
	input: { project_id: string; id: string },
): Promise<OptimizationEvent[]> {
	await getOptimizationJob(pool, input);
	return (
		await rows(
			pool,
			"SELECT e.id, e.status, e.detail, e.created_at FROM prompt_optimization_events e JOIN prompt_optimization_jobs j ON j.id=e.job_id JOIN projects p ON p.id = j.project_id AND p.status = 'active' WHERE j.project_id=$1 AND e.job_id=$2 ORDER BY e.id",
			[input.project_id, input.id],
		)
	).map((row) => ({
		id: number(row.id, "event id"),
		status: status(row.status),
		detail: json(row.detail, "event detail"),
		created_at: time(row.created_at),
	}));
}

export async function transitionOptimizationJob(
	pool: Pick<Pool, "connect">,
	input: {
		id: string;
		worker_id: string;
		status: OptimizationStatus;
		admission_id?: string;
		detail?: JsonObject;
		error_message?: string;
		metric_calls_used?: number | null;
	},
): Promise<OptimizationJob> {
	return tx(pool, async (client) => {
		const execution = await lockOptimizationExecution(client, input.id);
		if (!execution)
			throw fail("CONFLICT", "Optimization job is no longer active");
		if (
			input.admission_id &&
			!(await claimExecutionAdmission(client, {
				id: input.admission_id,
				project_id: execution.project_id,
				effect: "event_write",
			}))
		)
			throw fail("CONFLICT", "Optimization execution admission was cancelled");
		const row = (
			await rows(
				client,
				"UPDATE prompt_optimization_jobs SET status=$2, error_message=COALESCE($3,error_message), metric_calls_used=COALESCE($4,metric_calls_used), updated_at=now(), completed_at=CASE WHEN $2 IN ('completed','stopped','failed') THEN now() ELSE completed_at END WHERE id=$1 AND worker_claim_id=$5 AND worker_lease_expires_at >= now() AND status NOT IN ('completed','stopped','failed') RETURNING *",
				[
					input.id,
					input.status,
					input.error_message ?? null,
					input.metric_calls_used ?? null,
					input.worker_id,
				],
			)
		)[0];
		if (!row) throw fail("CONFLICT", "Optimization job is no longer active");
		await rows(
			client,
			"INSERT INTO prompt_optimization_events (job_id,status,detail) VALUES ($1,$2,$3::jsonb)",
			[input.id, input.status, JSON.stringify(input.detail ?? {})],
		);
		return mapJob(row);
	});
}

export async function stopOptimizationJob(
	pool: Pick<Pool, "connect">,
	input: {
		project_id: string;
		id: string;
		authorization: ProjectAuthorization;
	},
): Promise<OptimizationJob> {
	return tx(pool, async (client) => {
		if (
			!(await lockActiveAuthorizedProject(
				client,
				input.project_id,
				input.authorization,
			))
		)
			throw fail("NOT_FOUND", "Project is not available");
		const row = (
			await rows(
				client,
				"UPDATE prompt_optimization_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,now()), status='stopped', updated_at=now(), completed_at=now() WHERE id=$1 AND project_id=$2 AND status IN ('queued','preparing','optimizing','evaluating') RETURNING *",
				[input.id, input.project_id],
			)
		)[0];
		if (row) {
			await rows(
				client,
				"UPDATE execution_admissions SET status = 'cancelled', cancelled_at = now() WHERE work_kind = 'optimization' AND work_id = $1 AND status = 'active'",
				[input.id],
			);
			await rows(
				client,
				"INSERT INTO prompt_optimization_events (job_id,status) VALUES ($1,'stopped')",
				[input.id],
			);
			return mapJob(row);
		}
		const existing = (
			await rows(
				client,
				"SELECT * FROM prompt_optimization_jobs WHERE id=$1 AND project_id=$2",
				[input.id, input.project_id],
			)
		)[0];
		if (!existing) throw fail("NOT_FOUND", "Optimization job not found");
		const job = mapJob(existing);
		if (job.status === "stopped") return job;
		throw fail("CONFLICT", "Optimization job is already terminal");
	});
}

export async function cancelOptimizationExecution(
	pool: Pick<Pool, "connect">,
	input: { id: string; worker_id: string },
): Promise<void> {
	await tx(pool, async (client) => {
		const execution = await lockOptimizationExecution(client, input.id);
		if (!execution) return;
		const cancelled = await rows(
			client,
			"UPDATE prompt_optimization_jobs SET cancel_requested_at = COALESCE(cancel_requested_at, now()), status = 'stopped', updated_at = now(), completed_at = now() WHERE id = $1 AND worker_claim_id = $2 AND status IN ('queued', 'preparing', 'optimizing', 'evaluating') RETURNING id",
			[input.id, input.worker_id],
		);
		if (!cancelled.length) return;
		await rows(
			client,
			"INSERT INTO prompt_optimization_events (job_id, status, detail) VALUES ($1, 'stopped', '{\"reason\":\"execution_admission_cancelled\"}'::jsonb)",
			[input.id],
		);
	});
}

export async function completeOptimizationResult(
	pool: Pick<Pool, "connect">,
	input: {
		id: string;
		worker_id: string;
		candidate_content: string | null;
		evidence: OptimizationEvidence;
		promotion_status: "review_required" | "blocked";
		promotion_reason: string;
		admission_id?: string;
	},
): Promise<OptimizationJob> {
	return tx(pool, async (client) => {
		const execution = await lockOptimizationExecution(client, input.id);
		if (!execution)
			throw fail("CONFLICT", "Optimization job is no longer active");
		if (
			input.admission_id &&
			!(await claimExecutionAdmission(client, {
				id: input.admission_id,
				project_id: execution.project_id,
				effect: "result_write",
			}))
		)
			throw fail("CONFLICT", "Optimization execution admission was cancelled");
		const row = (
			await rows(
				client,
				"UPDATE prompt_optimization_jobs SET status='completed', candidate_content=$2, evidence=$3::jsonb, promotion_status=$4, promotion_reason=$5, updated_at=now(), completed_at=now() WHERE id=$1 AND worker_claim_id=$6 AND worker_lease_expires_at >= now() AND status NOT IN ('completed','stopped','failed') RETURNING *",
				[
					input.id,
					input.candidate_content,
					JSON.stringify(input.evidence),
					input.promotion_status,
					input.promotion_reason,
					input.worker_id,
				],
			)
		)[0];
		if (!row) throw fail("CONFLICT", "Optimization job is no longer active");
		const completed = mapJob(row);
		await rows(
			client,
			"INSERT INTO prompt_optimization_events (job_id,status,detail) VALUES ($1,'completed',$2::jsonb)",
			[
				input.id,
				JSON.stringify(
					resultEventDetail({
						evidence: input.evidence,
						promotion_status: input.promotion_status,
						promotion_reason: input.promotion_reason,
						metric_calls_used: completed.metric_calls_used,
					}),
				),
			],
		);
		return completed;
	});
}

export async function publishOptimizationResult(
	pool: Pick<Pool, "connect">,
	input: {
		id: string;
		worker_id: string;
		messages: PromptMessage[];
		evidence: OptimizationEvidence;
		admission_id?: string;
	},
): Promise<number> {
	return tx(pool, async (client) => {
		const execution = await lockOptimizationExecution(client, input.id);
		if (!execution)
			throw fail("CONFLICT", "Optimization worker claim was lost");
		if (
			input.admission_id &&
			!(await claimExecutionAdmission(client, {
				id: input.admission_id,
				project_id: execution.project_id,
				effect: "result_write",
			}))
		)
			throw fail("CONFLICT", "Optimization execution admission was cancelled");
		const jobRow = (
			await rows(
				client,
				"SELECT * FROM prompt_optimization_jobs WHERE id=$1 AND worker_claim_id=$2 AND worker_lease_expires_at >= now() FOR UPDATE",
				[input.id, input.worker_id],
			)
		)[0];
		if (!jobRow) throw fail("CONFLICT", "Optimization worker claim was lost");
		const job = mapJob(jobRow);
		if (job.result_version !== null) return job.result_version;
		if (job.status === "stopped" || jobRow.cancel_requested_at)
			throw fail("CONFLICT", "Optimization job was stopped");
		const latest = (
			await rows(
				client,
				"SELECT p.id, p.slug, v.version, v.model, v.settings FROM prompts p JOIN prompt_versions v ON v.prompt_id=p.id WHERE p.id=$1 ORDER BY v.version DESC LIMIT 1 FOR UPDATE",
				[job.prompt_id],
			)
		)[0];
		if (!latest) throw fail("NOT_FOUND", "Prompt not found");
		if (number(latest.version, "version") !== job.source_version)
			throw fail(
				"CONFLICT",
				"Source prompt version is no longer current; review the draft before promotion",
			);
		const version = number(latest.version, "version") + 1;
		const content = input.messages.find(
			(message) => message.role === job.target,
		)?.content;
		if (content === undefined)
			throw fail("INTERNAL", `Optimized ${job.target} message is missing`);
		await rows(
			client,
			"INSERT INTO prompt_versions (prompt_id,version,content,model,metadata,messages,settings,change_message,created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$5::jsonb,$7,$8)",
			[
				job.prompt_id,
				version,
				content,
				latest.model,
				JSON.stringify(json(latest.settings, "settings")),
				JSON.stringify(input.messages),
				"GEPA optimization",
				job.requested_by,
			],
		);
		await rows(
			client,
			"UPDATE prompt_optimization_jobs SET status='completed',result_version=$2,candidate_content=$3,evidence=$4::jsonb,promotion_status='auto_promoted',promotion_reason=NULL,updated_at=now(),completed_at=now(),promoted_at=now() WHERE id=$1",
			[job.id, version, content, JSON.stringify(input.evidence)],
		);
		await rows(
			client,
			"INSERT INTO prompt_optimization_events (job_id,status,detail) VALUES ($1,'completed',$2::jsonb)",
			[
				job.id,
				JSON.stringify(
					resultEventDetail({
						result_version: version,
						evidence: input.evidence,
						promotion_status: "auto_promoted",
						promotion_reason: null,
						metric_calls_used: job.metric_calls_used,
					}),
				),
			],
		);
		return version;
	});
}

export async function promoteOptimizationDraft(
	pool: Pick<Pool, "connect">,
	input: {
		project_id: string;
		id: string;
		actor: string;
		authorization: ProjectAuthorization;
	},
): Promise<OptimizationJob> {
	return tx(pool, async (client) => {
		if (
			!(await lockActiveAuthorizedProject(
				client,
				input.project_id,
				input.authorization,
			))
		)
			throw fail("NOT_FOUND", "Project is not available");
		const jobRow = (
			await rows(
				client,
				"SELECT j.* FROM prompt_optimization_jobs j JOIN projects p ON p.id=j.project_id AND p.status='active' WHERE j.id=$1 AND j.project_id=$2 FOR UPDATE OF j, p",
				[input.id, input.project_id],
			)
		)[0];
		if (!jobRow) throw fail("NOT_FOUND", "Optimization job not found");
		const job = mapJob(jobRow);
		if (job.target !== "system")
			throw fail(
				"CONFLICT",
				"Optimization draft is not eligible for promotion",
			);
		if (job.result_version !== null) return job;
		if (
			job.status !== "completed" ||
			job.promotion_status !== "review_required" ||
			job.candidate_content === null ||
			job.evidence === null ||
			job.evidence.leakage.status !== "passed"
		)
			throw fail(
				"CONFLICT",
				"Optimization draft is not eligible for promotion",
			);
		const latest = (
			await rows(
				client,
				"SELECT p.id, p.slug, v.version, v.model, v.settings FROM prompts p JOIN prompt_versions v ON v.prompt_id=p.id WHERE p.id=$1 ORDER BY v.version DESC LIMIT 1 FOR UPDATE",
				[job.prompt_id],
			)
		)[0];
		if (!latest) throw fail("NOT_FOUND", "Prompt not found");
		if (number(latest.version, "version") !== job.source_version)
			throw fail(
				"CONFLICT",
				"Source prompt version is no longer current; start a new optimization",
			);
		const version = number(latest.version, "version") + 1;
		const sourceMessages = messages(jobRow.source_messages).map((message) =>
			message.role === job.target
				? { ...message, content: job.candidate_content! }
				: message,
		);
		await rows(
			client,
			"INSERT INTO prompt_versions (prompt_id,version,content,model,metadata,messages,settings,change_message,created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$5::jsonb,$7,$8)",
			[
				job.prompt_id,
				version,
				job.candidate_content,
				latest.model,
				JSON.stringify(json(latest.settings, "settings")),
				JSON.stringify(sourceMessages),
				"GEPA optimization reviewed draft",
				input.actor,
			],
		);
		const updated = (
			await rows(
				client,
				"UPDATE prompt_optimization_jobs SET result_version=$2,promotion_status='reviewed_promoted',promotion_reason=NULL,reviewed_by=$3,promoted_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
				[job.id, version, input.actor],
			)
		)[0];
		if (!updated)
			throw fail("INTERNAL", "Optimization promotion update failed");
		await rows(
			client,
			"INSERT INTO prompt_optimization_events (job_id,status,detail) VALUES ($1,'completed',$2::jsonb)",
			[
				job.id,
				JSON.stringify(
					resultEventDetail({
						result_version: version,
						evidence: job.evidence,
						promotion_status: "reviewed_promoted",
						promotion_reason: null,
						reviewed_by: input.actor,
						metric_calls_used: job.metric_calls_used,
					}),
				),
			],
		);
		return mapJob(updated);
	});
}
