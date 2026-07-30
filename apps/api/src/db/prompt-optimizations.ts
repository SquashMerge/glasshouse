import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { JsonObject, PromptMessage, PromptRole } from "./prompts.js";
import { PromptRepositoryError } from "./prompts.js";

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
	examples: unknown[];
	model_config: JsonObject;
	budget: JsonObject;
	status: OptimizationStatus;
	requested_by: string;
	result_version: number | null;
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
function nullableTime(value: unknown): string | null {
	return value === null || value === undefined ? null : time(value);
}
function messages(value: unknown): PromptMessage[] {
	const parsed = typeof value === "string" ? JSON.parse(value) : value;
	if (!Array.isArray(parsed)) throw fail("INTERNAL", "Invalid source messages");
	return parsed as PromptMessage[];
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
		examples:
			typeof row.examples === "string"
				? JSON.parse(row.examples)
				: (row.examples as unknown[]),
		model_config: json(row.model_config, "model config"),
		budget: json(row.budget, "budget"),
		status: status(row.status),
		requested_by: String(row.requested_by),
		result_version:
			row.result_version === null
				? null
				: number(row.result_version, "result version"),
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

export async function createOptimizationJob(
	pool: Pick<Pool, "connect">,
	input: {
		project_id: string;
		slug: string;
		source_version: number;
		target: PromptRole;
		evaluator: JsonObject;
		examples: unknown[];
		model_config: JsonObject;
		budget: JsonObject;
		actor: string;
	},
): Promise<OptimizationJob> {
	if (!input.examples.length)
		throw fail("BAD_REQUEST", "examples must not be empty");
	return tx(pool, async (client) => {
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
				`INSERT INTO prompt_optimization_jobs (id, project_id, prompt_id, prompt_slug, source_version, target_role, source_messages, evaluator, examples, model_config, budget, status, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,'queued',$12) ON CONFLICT (project_id, prompt_id, source_version, target_role) WHERE status IN ('queued', 'preparing', 'optimizing', 'evaluating') DO UPDATE SET updated_at=prompt_optimization_jobs.updated_at RETURNING *, (xmax = 0) AS created`,
				[
					id,
					input.project_id,
					source.prompt_id,
					input.slug,
					input.source_version,
					input.target,
					JSON.stringify(messages(source.messages)),
					JSON.stringify(input.evaluator),
					JSON.stringify(input.examples),
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
			"SELECT * FROM prompt_optimization_jobs WHERE project_id = $1 AND id = $2",
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
			"SELECT * FROM prompt_optimization_jobs WHERE project_id=$1 AND prompt_slug=$2 AND status IN ('queued','preparing','optimizing','evaluating') ORDER BY created_at DESC LIMIT 1",
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
			"SELECT * FROM prompt_optimization_jobs WHERE project_id=$1 AND prompt_slug=$2 ORDER BY CASE WHEN status IN ('queued','preparing','optimizing','evaluating') THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 1",
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
			"SELECT DISTINCT ON (prompt_id) * FROM prompt_optimization_jobs WHERE project_id=$1 AND status IN ('queued','preparing','optimizing','evaluating') ORDER BY prompt_id, updated_at DESC, id DESC",
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
		const claimed = await rows(
			client,
			"UPDATE prompt_optimization_jobs j SET worker_claim_id=$2,worker_claimed_at=now(),worker_lease_expires_at=now() + interval '5 minutes',updated_at=now() FROM projects p WHERE j.id=$1 AND p.id=j.project_id AND p.status = 'active' AND j.status IN ('queued','preparing','optimizing','evaluating') AND (j.worker_claim_id IS NULL OR j.worker_lease_expires_at IS NULL OR j.worker_lease_expires_at < now()) RETURNING j.id",
			[input.id, input.worker_id],
		);
		return claimed.length === 1;
	});
}
export async function renewOptimizationJobLease(
	pool: Pick<Pool, "query">,
	input: { id: string; worker_id: string },
): Promise<boolean> {
	const renewed = await rows(
		pool,
		"UPDATE prompt_optimization_jobs j SET worker_lease_expires_at=now() + interval '5 minutes',updated_at=now() FROM projects p WHERE j.id=$1 AND j.worker_claim_id=$2 AND p.id=j.project_id AND p.status = 'active' AND j.worker_lease_expires_at >= now() AND j.status IN ('queued','preparing','optimizing','evaluating') RETURNING j.id",
		[input.id, input.worker_id],
	);
	return renewed.length === 1;
}
export async function recordOptimizationMetricCalls(
	pool: Pick<Pool, "query">,
	input: { id: string; worker_id: string; metric_calls_used: number },
): Promise<void> {
	const recorded = await rows(
		pool,
		"UPDATE prompt_optimization_jobs SET metric_calls_used=GREATEST(COALESCE(metric_calls_used,0),$3),updated_at=now() WHERE id=$1 AND worker_claim_id=$2 AND worker_lease_expires_at >= now() RETURNING id",
		[input.id, input.worker_id, input.metric_calls_used],
	);
	if (!recorded.length)
		throw fail("CONFLICT", "Optimization worker claim was lost");
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
			"SELECT j.source_messages FROM prompt_optimization_jobs j WHERE j.project_id=$1 AND j.id=$2",
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
			"SELECT e.id, e.status, e.detail, e.created_at FROM prompt_optimization_events e JOIN prompt_optimization_jobs j ON j.id=e.job_id WHERE j.project_id=$1 AND e.job_id=$2 ORDER BY e.id",
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
		detail?: JsonObject;
		error_message?: string;
		metric_calls_used?: number | null;
	},
): Promise<OptimizationJob> {
	return tx(pool, async (client) => {
		const row = (
			await rows(
				client,
"UPDATE prompt_optimization_jobs j SET status=$2, error_message=COALESCE($3,j.error_message), metric_calls_used=COALESCE($4,j.metric_calls_used), updated_at=now(), completed_at=CASE WHEN $2 IN ('completed','stopped','failed') THEN now() ELSE j.completed_at END FROM projects p WHERE j.id=$1 AND j.worker_claim_id=$5 AND p.id=j.project_id AND p.status = 'active' AND j.worker_lease_expires_at >= now() AND j.status NOT IN ('completed','stopped','failed') RETURNING j.*",
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
	input: { project_id: string; id: string },
): Promise<OptimizationJob> {
	return tx(pool, async (client) => {
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
export async function publishOptimizationResult(
	pool: Pick<Pool, "connect">,
	input: {
		id: string;
		worker_id: string;
		messages: PromptMessage[];
		score?: number;
	},
): Promise<number> {
	return tx(pool, async (client) => {
		const jobRow = (
			await rows(
				client,
				"SELECT j.* FROM prompt_optimization_jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=$1 AND j.worker_claim_id=$2 AND p.status = 'active' AND j.worker_lease_expires_at >= now() FOR UPDATE OF j, p",
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
			"UPDATE prompt_optimization_jobs j SET status='completed',result_version=$2,updated_at=now(),completed_at=now() FROM projects p WHERE j.id=$1 AND p.id=j.project_id AND p.status = 'active'",
			[job.id, version],
		);
		await rows(
			client,
			"INSERT INTO prompt_optimization_events (job_id,status,detail) VALUES ($1,'completed',$2::jsonb)",
			[
				job.id,
				JSON.stringify({
					result_version: version,
					...(typeof input.score === "number" && Number.isFinite(input.score)
						? { score: input.score }
						: {}),
					...(job.metric_calls_used === null
						? {}
						: { metric_calls_used: job.metric_calls_used }),
				}),
			],
		);
		return version;
	});
}
