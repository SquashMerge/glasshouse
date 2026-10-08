import { createRoute, type RouteHandler, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Pool } from "pg";
import { streamSSE } from "hono/streaming";
import { getDataset, listPublishedDatasetItems } from "../db/datasets.js";
import {
	admitEvaluationRun,
	EvaluationRunRepositoryError,
} from "../db/evaluation-runs.js";
import {
	cancelExperiment as cancelExperimentRecord,
	claimExperimentTask,
	heartbeatExperimentTask,
	claimExperimentExecution,
	completeExperimentIfTasksFinished,
	reconcileUnknownExperimentTaskProviderDispatch,
	recordExperimentResultTrace,
	reserveExperimentTaskCost,
	reserveExperimentTaskProviderCall,
	admitExperimentExecution,
	createExperiment as createExperimentRecord,
	experimentExecutionAdmissionIsActive,
	ExperimentRepositoryError,
	experimentSummary as experimentSummaryRecord,
	finalizeExperimentTask,
	getExperiment as getExperimentRecord,
	insertExperimentResult,
	listExperimentResults,
	listExperiments as listExperimentsRecord,
	nextExperimentTaskRetryDelay,
	updateExperiment,
} from "../db/experiments.js";
import {
	cancelExecutionAdmission,
	completeExecutionAdmission,
	executionOperationKey,
	providerDispatchKey,
} from "../db/execution-admissions.js";
import { evaluationWorkerActorId } from "../db/actors.js";
import { projectAuthorization } from "../db/project-authorization.js";
import { pgPool } from "../db/postgres.js";
import { explainCase } from "../lib/evaluator.js";
import {
	invokeConfiguredLlm,
	isUncertainLlmFailure,
	LlmProviderError,
} from "../lib/llm.js";
import { logger } from "../lib/logger.js";
import {
	authorizedSseFrame,
	createAuthorizedSseDelivery,
} from "../lib/authorized-sse.js";
import {
	executionAdmissionTimeoutMs,
	invokeWithExecutionAdmission,
} from "../lib/execution-admission.js";
import {
	Experiment,
	ExperimentCreate,
	ExperimentErrorResponses,
	ExperimentRunAdmissionErrorResponses,
	ExperimentIdParam,
	ExperimentList,
	ExperimentProjectQuery,
	ExperimentResults,
	ExperimentSummary,
} from "../schemas/experiments.js";
import {
	trustedTenant,
	withActiveInternalEvaluationProjectLock,
} from "../tenancy.js";
import { createOtlpIngestHandler } from "./otlp.js";

const tag = "experiments";
const errorResponse = (c: Context, cause: unknown): Response => {
	const error =
		cause instanceof ExperimentRepositoryError
			? cause
			: cause instanceof EvaluationRunRepositoryError
				? cause
				: new ExperimentRepositoryError(
						"INTERNAL",
						"Experiment operation failed",
						cause,
					);
	if (error.status === 500) logger.error("experiments.request_failed", cause);
	return c.json(
		{
			code: error.code,
			message:
				error.code === "INTERNAL"
					? "Experiment operation failed"
					: error.message,
		},
		error.status,
	);
};

export const createExperiment = createRoute({
	method: "post",
	path: "/v1/experiments",
	tags: [tag],
	summary: "Create and run an LLM evaluation",
	description:
		"Compatibility start route. Target configuration must be empty because admission accepts only the pinned Definition Version's exact operator-allowed provider/model pair and immutable bounds (active limits 1-32 per Project and actor; requested sample-size and provider-call limits 1-10,000 per Run). The sample-size limit is checked before Dataset items are materialized.",
	security: [{ basicAuth: [] }],
	request: {
		body: {
			content: { "application/json": { schema: ExperimentCreate } },
			required: true,
		},
	},
	responses: {
		201: {
			description: "Experiment created",
			content: { "application/json": { schema: Experiment } },
		},
		...ExperimentRunAdmissionErrorResponses,
	},
});
export const listExperiments = createRoute({
	method: "get",
	path: "/v1/experiments",
	tags: [tag],
	summary: "List evaluations",
	security: [{ basicAuth: [] }],
	request: { query: ExperimentProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: ExperimentList } },
		},
		...ExperimentErrorResponses,
	},
});
export const getExperiment = createRoute({
	method: "get",
	path: "/v1/experiments/{id}",
	tags: [tag],
	summary: "Get an evaluation",
	security: [{ basicAuth: [] }],
	request: { params: ExperimentIdParam, query: ExperimentProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Experiment } },
		},
		...ExperimentErrorResponses,
	},
});
export const getExperimentResults = createRoute({
	method: "get",
	path: "/v1/experiments/{id}/results",
	tags: [tag],
	summary: "Get evaluation results",
	security: [{ basicAuth: [] }],
	request: { params: ExperimentIdParam, query: ExperimentProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: ExperimentResults } },
		},
		...ExperimentErrorResponses,
	},
});
export const getExperimentSummary = createRoute({
	method: "get",
	path: "/v1/experiments/{id}/summary",
	tags: [tag],
	summary: "Get evaluation summary",
	security: [{ basicAuth: [] }],
	request: { params: ExperimentIdParam, query: ExperimentProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: ExperimentSummary } },
		},
		...ExperimentErrorResponses,
	},
});
export const getExperimentEvents = createRoute({
	method: "get",
	path: "/v1/experiments/{id}/events",
	tags: [tag],
	summary: "Stream evaluation lifecycle events",
	security: [{ basicAuth: [] }],
	request: { params: ExperimentIdParam, query: ExperimentProjectQuery },
	responses: {
		200: {
			description: "OK (text/event-stream)",
			content: { "text/event-stream": { schema: z.string() } },
		},
		...ExperimentErrorResponses,
	},
});
export const cancelExperiment = createRoute({
	method: "post",
	path: "/v1/experiments/{id}/cancel",
	tags: [tag],
	summary: "Cancel a running evaluation",
	security: [{ basicAuth: [] }],
	request: { params: ExperimentIdParam, query: ExperimentProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Experiment } },
		},
		...ExperimentErrorResponses,
	},
});

export type ExperimentDependencies = {
	pool: typeof pgPool;
	createExperiment: typeof createExperimentRecord;
	listExperiments: typeof listExperimentsRecord;
	getExperiment: typeof getExperimentRecord;
	updateExperiment: typeof updateExperiment;
	cancelExperiment: typeof cancelExperimentRecord;
	listResults: typeof listExperimentResults;
	insertResult: typeof insertExperimentResult;
	claimTask: typeof claimExperimentTask;
	heartbeatTask?: typeof heartbeatExperimentTask;
	nextTaskRetryDelay: typeof nextExperimentTaskRetryDelay;
	waitForTaskRetry: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	finalizeTask: typeof finalizeExperimentTask;
	completeExperiment: typeof completeExperimentIfTasksFinished;
	admitExecution: typeof admitExperimentExecution;
	isAdmissionActive: typeof experimentExecutionAdmissionIsActive;
	cancelAdmission: typeof cancelExecutionAdmission;
	completeAdmission: typeof completeExecutionAdmission;
	claimExecution: typeof claimExperimentExecution;
	reserveCost?: typeof reserveExperimentTaskCost;
	reserveProviderCall?: typeof reserveExperimentTaskProviderCall;
	reconcileUnknownProviderDispatch: typeof reconcileUnknownExperimentTaskProviderDispatch;
	summary: typeof experimentSummaryRecord;
	listPublishedDatasetItems: typeof listPublishedDatasetItems;
	getDataset: typeof getDataset;
	invokeLlm: typeof invokeConfiguredLlm;
	trace: (input: {
		project_id: string;
		experiment_id: string;
		item_id: string;
		model: string;
		input: Record<string, unknown>;
		output: string;
		duration_ms: number;
	}) => Promise<string | void>;
	recordResultTrace?: (
		db: Pick<Pool, "connect">,
		input: {
			project_id: string;
			experiment_id: string;
			task_id: string;
			trace_id: string;
			admission_id: string;
		},
	) => Promise<void>;
};

export function createEvaluationTracePayload(
	input: Parameters<ExperimentDependencies["trace"]>[0],
) {
	const traceId = crypto.randomUUID().replaceAll("-", "");
	const spanId = traceId.slice(0, 16);
	const start =
		BigInt(Date.now()) * 1_000_000n - BigInt(input.duration_ms) * 1_000_000n;
	const end = BigInt(Date.now()) * 1_000_000n;
	return {
		resource_spans: [
			{
				resource: {
					attributes: [
						{
							key: "service.name",
							value: { stringValue: "glasshouse-evaluation" },
						},
						{
							key: "glasshouse.project.id",
							value: { stringValue: input.project_id },
						},
					],
				},
				scope_spans: [
					{
						spans: [
							{
								trace_id: traceId,
								span_id: spanId,
								name: `evaluation.${input.experiment_id}`,
								kind: 1,
								start_time_unix_nano: start.toString(),
								end_time_unix_nano: end.toString(),
								attributes: [
									{
										key: "gen_ai.response.model",
										value: { stringValue: input.model },
									},
									{
										key: "input.value",
										value: { stringValue: JSON.stringify(input.input) },
									},
									{
										key: "output.value",
										value: { stringValue: input.output },
									},
								],
							},
						],
					},
				],
			},
		],
	};
}

export function createProductionTrace(
	traceResult?: ReturnType<typeof createOtlpIngestHandler>,
	pool = pgPool,
): ExperimentDependencies["trace"] {
	const ingest =
		traceResult ??
		createOtlpIngestHandler({
			withActiveAuthorizedProjectLock: (tenant, callback) =>
				withActiveInternalEvaluationProjectLock(pool(), tenant, callback),
		});
	return async (input) => {
		const organization = await pool().query<{ organization_id: string }>(
			"SELECT organization_id FROM projects WHERE id = $1 AND status = 'active'",
			[input.project_id],
		);
		const organizationId = organization.rows[0]?.organization_id;
		if (!organizationId) return;
		const payload = createEvaluationTracePayload(input);
		const response = await ingest(
			new Request("http://internal/v1/otel/v1/traces", {
				method: "POST",
				body: JSON.stringify(payload),
				headers: { "content-type": "application/json" },
			}),
			{
				actorId: evaluationWorkerActorId(organizationId),
				organizationId,
				projectId: input.project_id,
			},
		);
		if (!response.ok) throw new Error("OTLP trace ingestion failed");
		return payload.resource_spans[0]!.scope_spans[0]!.spans[0]!.trace_id;
	};
}

export const production: ExperimentDependencies = {
	pool: pgPool,
	createExperiment: createExperimentRecord,
	listExperiments: listExperimentsRecord,
	getExperiment: getExperimentRecord,
	updateExperiment,
	cancelExperiment: cancelExperimentRecord,
	listResults: listExperimentResults,
	insertResult: insertExperimentResult,
	claimTask: claimExperimentTask,
	heartbeatTask: heartbeatExperimentTask,
	nextTaskRetryDelay: nextExperimentTaskRetryDelay,
	waitForTaskRetry: (delayMs, signal) =>
		new Promise((resolve) => {
			const timer = setTimeout(resolve, delayMs);
			timer.unref();
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		}),
	finalizeTask: finalizeExperimentTask,
	completeExperiment: completeExperimentIfTasksFinished,
	admitExecution: admitExperimentExecution,
	isAdmissionActive: experimentExecutionAdmissionIsActive,
	cancelAdmission: cancelExecutionAdmission,
	completeAdmission: completeExecutionAdmission,
	claimExecution: claimExperimentExecution,
	reserveCost: reserveExperimentTaskCost,
	reserveProviderCall: reserveExperimentTaskProviderCall,
	reconcileUnknownProviderDispatch:
		reconcileUnknownExperimentTaskProviderDispatch,
	recordResultTrace: recordExperimentResultTrace,
	summary: experimentSummaryRecord,
	listPublishedDatasetItems,
	getDataset,
	invokeLlm: invokeConfiguredLlm,
	trace: createProductionTrace(),
};

const activeExperiments = new Map<string, AbortController>();
const experimentKey = (projectId: string, experimentId: string) =>
	`${projectId}:${experimentId}`;
export function experimentFromEvaluationRun(run: {
	experiment_id: string;
	project_id: string;
	experiment_agent_id: string | null;
	dataset_id: string;
	dataset_version_id: string;
	experiment_name: string | null;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	created_at: string;
	updated_at: string;
}) {
	return {
		id: run.experiment_id,
		project_id: run.project_id,
		agent_id: run.experiment_agent_id,
		dataset_id: run.dataset_id,
		resolved_dataset_version_id: run.dataset_version_id,
		dataset_input_binding: "versioned" as const,
		name: run.experiment_name,
		status: run.status,
		created_at: run.created_at,
		updated_at: run.updated_at,
	};
}
const abortedExecutionStatus = (signal?: AbortSignal) =>
	signal?.reason === "duration_limit" || signal?.reason === "execution_timeout"
		? ("failed" as const)
		: ("cancelled" as const);

const abortedExecutionReason = (signal?: AbortSignal) =>
	signal?.reason === "duration_limit"
		? "duration_limit"
		: signal?.reason === "execution_timeout"
			? "execution_timeout"
			: "cancelled_by_request";

function configuredMaxCost(config: Record<string, unknown>): number | null {
	const limits = config.limits;
	if (typeof limits !== "object" || limits === null) return null;
	const maxCost = (limits as Record<string, unknown>).max_cost_usd;
	return typeof maxCost === "number" && Number.isFinite(maxCost) && maxCost >= 0
		? maxCost
		: null;
}

async function terminalizeAbortedTask(
	deps: ExperimentDependencies,
	db: ReturnType<ExperimentDependencies["pool"]>,
	input: {
		project_id: string;
		experiment_id: string;
	},
	task: NonNullable<Awaited<ReturnType<ExperimentDependencies["claimTask"]>>>,
	evaluator: string,
	signal?: AbortSignal,
	itemStarted = Date.now(),
) {
	const timedOut = signal?.reason === "duration_limit";
	const admissionTimedOut = signal?.reason === "execution_timeout";
	const unavailable = !signal?.aborted;
	return deps.finalizeTask(db, {
		project_id: input.project_id,
		experiment_id: input.experiment_id,
		task_id: task.id,
		lease_token: task.lease_token,
		status: timedOut || admissionTimedOut ? "failed" : "cancelled",
		retryable: false,
		output: null,
		scores: { [evaluator]: 0 },
		duration_ms: Date.now() - itemStarted,
		error_classification: timedOut
			? "duration_limit"
			: admissionTimedOut
				? "execution_timeout"
				: unavailable
					? "authorization_revoked"
					: "cancelled_by_request",
		error_message: timedOut
			? "evaluation run duration limit exceeded"
			: admissionTimedOut
				? "execution admission deadline exceeded"
				: unavailable
					? "execution authorization unavailable"
					: "evaluation run cancelled",
	});
}

export async function executeExperiment(
	deps: ExperimentDependencies,
	input: {
		project_id: string;
		experiment_id: string;
		dataset_id: string;
		config: Record<string, unknown>;
	},
	signal?: AbortSignal,
) {
	const db = deps.pool();
	const started = await deps.updateExperiment(db, {
		project_id: input.project_id,
		id: input.experiment_id,
		status: "running",
		if_status: "pending",
	});
	if (started.status !== undefined && started.status !== "running") return;
	const evaluator =
		input.config.evaluator === "contains" ? "contains" : "exact_match";
	for (;;) {
		if (signal?.aborted) {
			await deps.updateExperiment(db, {
				project_id: input.project_id,
				id: input.experiment_id,
				status: abortedExecutionStatus(signal),
				if_status: ["pending", "running"],
				terminal_reason:
					signal?.reason === "duration_limit"
						? "duration_limit"
						: "cancelled_by_request",
			});
			return;
		}
		const task = await deps.claimTask(db, {
			project_id: input.project_id,
			experiment_id: input.experiment_id,
		});
		if (!task) {
			const completed = await deps.completeExperiment(db, {
				project_id: input.project_id,
				id: input.experiment_id,
			});
			if (completed) return;
			const retryDelay = await deps.nextTaskRetryDelay(db, {
				project_id: input.project_id,
				experiment_id: input.experiment_id,
			});
			if (retryDelay == null) return;
			await deps.waitForTaskRetry(retryDelay + 1, signal);
			continue;
		}
		const itemStarted = Date.now();
		let admissionId: string | undefined;
		try {
			const reservation = deps.reserveCost
				? await deps.reserveCost(db, {
						project_id: input.project_id,
						experiment_id: input.experiment_id,
						task_id: task.id,
						lease_token: task.lease_token,
					})
				: ({ reserved: false, reason: "not_configured" } as const);
			if (!reservation.reserved && reservation.reason !== "not_configured") {
				const reservationFailure = reservation.reason;
				await deps.finalizeTask(db, {
					project_id: input.project_id,
					experiment_id: input.experiment_id,
					task_id: task.id,
					lease_token: task.lease_token,
					status: "failed",
					retryable: false,
					output: null,
					scores: { [evaluator]: 0 },
					duration_ms: Date.now() - itemStarted,
					error_classification: reservationFailure,
					error_message:
						reservationFailure === "snapshot_missing"
							? "evaluation run snapshot missing"
							: "evaluation cost limit exceeded",
				});
				await deps.updateExperiment(db, {
					project_id: input.project_id,
					id: input.experiment_id,
					status: "failed",
					if_status: ["pending", "running"],
					terminal_reason: reservationFailure,
				});
				return;
			}
			const admission = await deps.admitExecution(db, {
				project_id: input.project_id,
				id: input.experiment_id,
				work_id: task.id,
				timeout_ms: executionAdmissionTimeoutMs(),
			});
			if (!admission) {
				await terminalizeAbortedTask(
					deps,
					db,
					input,
					task,
					evaluator,
					signal,
					itemStarted,
				);
				await deps.updateExperiment(db, {
					project_id: input.project_id,
					id: input.experiment_id,
					status: abortedExecutionStatus(signal),
					if_status: ["pending", "running"],
					terminal_reason: "authorization_revoked",
				});
				return;
			}
			admissionId = admission.id;
			let providerCallFailure:
				| "provider_call_limit_exceeded"
				| "snapshot_missing"
				| undefined;
			const dispatchKey = providerDispatchKey(
				"experiment_task",
				task.id,
				task.attempt_count || 1,
			);
			const heartbeat = deps.heartbeatTask
				? setInterval(() => {
						void deps.heartbeatTask!(db, {
							project_id: input.project_id,
							experiment_id: input.experiment_id,
							task_id: task.id,
							lease_token: task.lease_token,
						});
					}, 15_000)
				: undefined;
			let provider:
				| {
						admitted: true;
						value: Awaited<ReturnType<ExperimentDependencies["invokeLlm"]>>;
				  }
				| {
						admitted: false;
						reason: "unavailable" | "existing" | "rejected" | "timeout";
				  };
			try {
				provider = await invokeWithExecutionAdmission({
					parentSignal: signal,
					isActive: () =>
						deps.isAdmissionActive(db, {
							project_id: input.project_id,
							id: input.experiment_id,
							admission_id: admission.id,
						}),
					claimDispatch: () =>
						deps.claimExecution(db, {
							project_id: input.project_id,
							id: input.experiment_id,
							admission_id: admission.id,
							effect: "provider_dispatch",
							effect_key: dispatchKey,
						}),
					cancel: () => deps.cancelAdmission(db, admission.id),
					beforeInvoke: async () => {
						const providerCall = deps.reserveProviderCall
							? await deps.reserveProviderCall(db, {
									project_id: input.project_id,
									experiment_id: input.experiment_id,
								})
							: ({ reserved: false, reason: "not_configured" } as const);
						if (
							providerCall.reserved ||
							providerCall.reason === "not_configured"
						)
							return true;
						providerCallFailure = providerCall.reason;
						return false;
					},
					invoke: (providerSignal) =>
						deps.invokeLlm(
							task.input,
							input.config,
							providerSignal,
							dispatchKey,
						),
				});
			} finally {
				if (heartbeat) clearInterval(heartbeat);
			}
			if (!provider.admitted) {
				if (provider.reason === "timeout") {
					await terminalizeAbortedTask(
						deps,
						db,
						input,
						task,
						evaluator,
						AbortSignal.abort("execution_timeout"),
						itemStarted,
					);
					await deps.updateExperiment(db, {
						project_id: input.project_id,
						id: input.experiment_id,
						status: "failed",
						if_status: ["pending", "running"],
						terminal_reason: "execution_timeout",
					});
					return;
				}
				if (signal?.aborted) {
					await terminalizeAbortedTask(
						deps,
						db,
						input,
						task,
						evaluator,
						signal,
						itemStarted,
					);
					await deps.updateExperiment(db, {
						project_id: input.project_id,
						id: input.experiment_id,
						status: abortedExecutionStatus(signal),
						if_status: ["pending", "running"],
						terminal_reason:
							signal?.reason === "duration_limit"
								? "duration_limit"
								: "cancelled_by_request",
					});
					return;
				}
				if (provider.reason === "rejected" && providerCallFailure) {
					await deps.finalizeTask(db, {
						project_id: input.project_id,
						experiment_id: input.experiment_id,
						task_id: task.id,
						lease_token: task.lease_token,
						status: "failed",
						retryable: false,
						output: null,
						scores: { [evaluator]: 0 },
						duration_ms: Date.now() - itemStarted,
						error_classification: providerCallFailure,
						error_message:
							providerCallFailure === "snapshot_missing"
								? "evaluation run snapshot missing"
								: "evaluation provider-call limit exceeded",
					});
					await deps.updateExperiment(db, {
						project_id: input.project_id,
						id: input.experiment_id,
						status: "failed",
						if_status: ["pending", "running"],
						terminal_reason: providerCallFailure,
					});
					return;
				}
				if (provider.reason === "existing") {
					const reconciled = await deps.reconcileUnknownProviderDispatch(db, {
						project_id: input.project_id,
						experiment_id: input.experiment_id,
						task_id: task.id,
						lease_token: task.lease_token,
					});
					if (reconciled) continue;
				}
				await deps.updateExperiment(db, {
					project_id: input.project_id,
					id: input.experiment_id,
					status: abortedExecutionStatus(signal),
					if_status: ["pending", "running"],
					terminal_reason: "authorization_revoked",
				});
				return;
			}
			const llm = provider.value;
			const rationale = explainCase(
				{
					kind: evaluator,
					version: "v1",
					expected_output_path:
						typeof input.config.expected_output_path === "string"
							? input.config.expected_output_path
							: "$.expected_output",
					output_path:
						typeof input.config.output_path === "string"
							? input.config.output_path
							: "$.output",
				},
				{ expected_output: task.expected_output },
				{ output: llm.output },
			);
			const score = Number(rationale.score);
			const scores = { [evaluator]: score };
			const duration_ms = Date.now() - itemStarted;
			const providerCost =
				typeof llm.cost_usd === "number" &&
				Number.isFinite(llm.cost_usd) &&
				llm.cost_usd >= 0
					? llm.cost_usd
					: null;
			const costKnown = providerCost !== null;
			const maxCost = configuredMaxCost(input.config);
			let costLimitFailure: "cost_unknown" | "cost_limit_exceeded" | null =
				null;
			if (maxCost !== null) {
				if (!costKnown) costLimitFailure = "cost_unknown";
				else if (providerCost >= maxCost)
					costLimitFailure = "cost_limit_exceeded";
			}
			const costLimitMessage =
				costLimitFailure === "cost_unknown"
					? "provider did not return billable cost"
					: costLimitFailure === "cost_limit_exceeded"
						? "evaluation cost limit exceeded"
						: null;
			const finalized = await deps.finalizeTask(db, {
				project_id: input.project_id,
				experiment_id: input.experiment_id,
				task_id: task.id,
				lease_token: task.lease_token,
				output: llm.output,
				scores,
				duration_ms,
				status:
					costLimitFailure || !costKnown || scores[evaluator] !== 1
						? "failed"
						: "completed",
				cost_usd: providerCost,
				error_classification:
					costLimitFailure ?? (!costKnown ? "cost_unknown" : null),
				error_message:
					costLimitMessage ??
					(!costKnown ? "provider did not return billable cost" : null),
				agent_version: llm.model,
				evaluator_rationale: rationale,
				admission_id: admission.id,
			});
			if (!finalized) return;
			if (costLimitFailure) {
				await deps.updateExperiment(db, {
					project_id: input.project_id,
					id: input.experiment_id,
					status: "failed",
					if_status: ["pending", "running"],
					terminal_reason: costLimitFailure,
				});
				return;
			}
			try {
				const traceAdmission = await invokeWithExecutionAdmission({
					parentSignal: signal,
					isActive: () =>
						deps.isAdmissionActive(db, {
							project_id: input.project_id,
							id: input.experiment_id,
							admission_id: admission.id,
						}),
					claimDispatch: () =>
						deps.claimExecution(db, {
							project_id: input.project_id,
							id: input.experiment_id,
							admission_id: admission.id,
							effect: "trace_write",
							effect_key: executionOperationKey(
								"trace_write",
								task.attempt_count || 1,
							),
						}),
					cancel: () => deps.cancelAdmission(db, admission.id),
					invoke: () =>
						deps.trace({
							project_id: input.project_id,
							experiment_id: input.experiment_id,
							item_id:
								task.dataset_item_id ?? task.dataset_version_item_id ?? task.id,
							model: llm.model,
							input: task.input,
							output: JSON.stringify(llm.output),
							duration_ms,
						}),
				});
				if (!traceAdmission.admitted) {
					continue;
				}
				if (deps.recordResultTrace && typeof traceAdmission.value === "string")
					await deps.recordResultTrace(db, {
						project_id: input.project_id,
						experiment_id: input.experiment_id,
						task_id: task.id,
						trace_id: traceAdmission.value,
						admission_id: admission.id,
					});
			} catch (traceError) {
				logger.warn("evaluation.trace_failed", traceError, {
					experiment_id: input.experiment_id,
					dataset_item_id: task.dataset_item_id,
				});
			}
		} catch (cause) {
			if (signal?.aborted) {
				await terminalizeAbortedTask(
					deps,
					db,
					input,
					task,
					evaluator,
					signal,
					itemStarted,
				);
				await deps.updateExperiment(db, {
					project_id: input.project_id,
					id: input.experiment_id,
					status: abortedExecutionStatus(signal),
					if_status: ["pending", "running"],
					terminal_reason: abortedExecutionReason(signal),
				});
				return;
			}
			const duration_ms = Date.now() - itemStarted;
			const uncertain =
				isUncertainLlmFailure(cause) || !(cause instanceof LlmProviderError);
			const finalized = await deps.finalizeTask(db, {
				project_id: input.project_id,
				experiment_id: input.experiment_id,
				task_id: task.id,
				lease_token: task.lease_token,
				output: null,
				scores: { [evaluator]: 0 },
				duration_ms,
				status: "failed",
				retryable:
					!uncertain &&
					(cause instanceof LlmProviderError ? cause.safeToRetry : false),
				error_classification: uncertain ? "unknown_dispatch" : "provider_error",
				error_message: uncertain
					? "provider dispatch outcome is unknown"
					: "provider invocation failed",
				...(admissionId ? { admission_id: admissionId } : {}),
			});
			if (!finalized) return;
			try {
				if (!admissionId) continue;
				const traceAdmission = await invokeWithExecutionAdmission({
					parentSignal: signal,
					isActive: () =>
						deps.isAdmissionActive(db, {
							project_id: input.project_id,
							id: input.experiment_id,
							admission_id: admissionId!,
						}),
					claimDispatch: () =>
						deps.claimExecution(db, {
							project_id: input.project_id,
							id: input.experiment_id,
							admission_id: admissionId!,
							effect: "trace_write",
							effect_key: executionOperationKey(
								"trace_write",
								task.attempt_count || 1,
							),
						}),
					cancel: () => deps.cancelAdmission(db, admissionId!),
					invoke: () =>
						deps.trace({
							project_id: input.project_id,
							experiment_id: input.experiment_id,
							item_id:
								task.dataset_item_id ?? task.dataset_version_item_id ?? task.id,
							model:
								typeof input.config.model === "string"
									? input.config.model
									: "configured-model",
							input: task.input,
							output: "evaluation_failed",
							duration_ms,
						}),
				});
				if (!traceAdmission.admitted) return;
				if (deps.recordResultTrace && typeof traceAdmission.value === "string")
					await deps.recordResultTrace(db, {
						project_id: input.project_id,
						experiment_id: input.experiment_id,
						task_id: task.id,
						trace_id: traceAdmission.value,
						admission_id: admissionId,
					});
			} catch (traceError) {
				logger.warn("evaluation.trace_failed", traceError, {
					experiment_id: input.experiment_id,
					dataset_item_id: task.dataset_item_id,
				});
			}
		} finally {
			if (admissionId)
				await deps.completeAdmission(db, admissionId).catch(() => {});
		}
	}
	if (signal?.aborted) {
		await deps.updateExperiment(db, {
			project_id: input.project_id,
			id: input.experiment_id,
			status: abortedExecutionStatus(signal),
			if_status: ["pending", "running"],
			terminal_reason:
				signal?.reason === "duration_limit"
					? "duration_limit"
					: "cancelled_by_request",
		});
		return;
	}
	await deps.completeExperiment(db, {
		project_id: input.project_id,
		id: input.experiment_id,
	});
}

export function evaluationRunConfig(snapshot: {
	target: Record<string, unknown>;
	evaluator: Record<string, unknown>;
	execution_defaults: Record<string, unknown>;
	limits?: Record<string, unknown>;
	execution_bounds?: Record<string, unknown>;
}) {
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
		execution_bounds: snapshot.execution_bounds,
	};
}

export function evaluationRunConcurrency(): number {
	const configured = Number(process.env.EVALUATION_RUN_CONCURRENCY ?? 4);
	return Number.isSafeInteger(configured) && configured >= 1 && configured <= 32
		? configured
		: 4;
}

export async function executeEvaluationRun(
	deps: ExperimentDependencies,
	input: {
		project_id: string;
		experiment_id: string;
		evaluation_run_id?: string;
		dataset_id: string;
		config: Record<string, unknown>;
	},
	signal?: AbortSignal,
	concurrency = evaluationRunConcurrency(),
) {
	const workers = Math.max(1, Math.min(32, Math.floor(concurrency)));
	const controller = new AbortController();
	const onParentAbort = () => controller.abort(signal?.reason ?? "cancelled");
	signal?.addEventListener("abort", onParentAbort, { once: true });
	if (signal?.aborted) controller.abort(signal.reason ?? "cancelled");
	const durationSeconds =
		typeof input.config.limits === "object" && input.config.limits !== null
			? (input.config.limits as Record<string, unknown>).max_duration_seconds
			: undefined;
	let timedOut = false;
	const deadline =
		typeof durationSeconds === "number" && durationSeconds > 0
			? setTimeout(() => {
					timedOut = true;
					controller.abort("duration_limit");
				}, durationSeconds * 1000)
			: undefined;
	try {
		await Promise.all(
			Array.from({ length: workers }, () =>
				executeExperiment(deps, input, controller.signal),
			),
		);
	} catch (cause) {
		await deps
			.updateExperiment(deps.pool(), {
				project_id: input.project_id,
				id: input.experiment_id,
				status: controller.signal.aborted
					? abortedExecutionStatus(controller.signal)
					: "failed",
				if_status: ["pending", "running"],
				terminal_reason: timedOut
					? "duration_limit"
					: signal?.aborted
						? signal.reason === "execution_timeout"
							? "execution_timeout"
							: "cancelled_by_request"
						: "execution_failed",
			})
			.catch(() => {});
		throw cause;
	} finally {
		if (deadline) clearTimeout(deadline);
		signal?.removeEventListener("abort", onParentAbort);
	}
}

export function createExperimentHandlers(
	deps: ExperimentDependencies = production,
) {
	return {
		handleCreateExperiment: async (
			c: Parameters<RouteHandler<typeof createExperiment>>[0],
		) => {
			try {
				const body = c.req.valid("json");
				const db = deps.pool();
				if (
					typeof body.evaluation_id !== "string" ||
					typeof body.definition_version !== "number" ||
					typeof body.idempotency_key !== "string"
				)
					throw new ExperimentRepositoryError(
						"CONFLICT",
						"The compatibility route requires evaluation_id, definition_version, and idempotency_key",
					);
				const run = await admitEvaluationRun(db, {
					project_id: body.project_id,
					evaluation_selector: body.evaluation_id,
					definition_version: body.definition_version,
					idempotency_key: body.idempotency_key,
					expected_dataset_id: body.dataset_id,
					authorization: projectAuthorization(trustedTenant(c), "execute"),
				});
				if (!run.replayed) {
					const controller = new AbortController();
					activeExperiments.set(
						experimentKey(body.project_id, run.experiment_id),
						controller,
					);
					void executeEvaluationRun(
						deps,
						{
							project_id: body.project_id,
							experiment_id: run.experiment_id,
							evaluation_run_id: run.id,
							dataset_id: run.dataset_id,
							config: evaluationRunConfig(run.snapshot),
						},
						controller.signal,
					)
						.catch(async (cause) => {
							logger.error("evaluation.failed", cause, {
								experiment_id: run.experiment_id,
								project_id: body.project_id,
							});
							await deps.updateExperiment(deps.pool(), {
								project_id: body.project_id,
								id: run.experiment_id,
								status: controller.signal.aborted
									? abortedExecutionStatus(controller.signal)
									: "failed",
								if_status: controller.signal.aborted
									? ["pending", "running"]
									: ["pending", "running"],
								terminal_reason:
									controller.signal.reason === "duration_limit"
										? "duration_limit"
										: controller.signal.reason === "execution_timeout"
											? "execution_timeout"
											: controller.signal.aborted
												? "cancelled_by_request"
												: "execution_failed",
							});
						})
						.finally(() =>
							activeExperiments.delete(
								experimentKey(body.project_id, run.experiment_id),
							),
						);
				}
				return c.json(experimentFromEvaluationRun(run), 201);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleListExperiments: async (
			c: Parameters<RouteHandler<typeof listExperiments>>[0],
		) => {
			try {
				return c.json(
					await deps.listExperiments(deps.pool(), {
						project_id: c.req.valid("query").project_id,
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_read",
						),
					}),
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleGetExperiment: async (
			c: Parameters<RouteHandler<typeof getExperiment>>[0],
		) => {
			try {
				return c.json(
					await deps.getExperiment(deps.pool(), {
						id: c.req.valid("param").id,
						project_id: c.req.valid("query").project_id,
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_read",
						),
					}),
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleGetExperimentResults: async (
			c: Parameters<RouteHandler<typeof getExperimentResults>>[0],
		) => {
			try {
				return c.json(
					await deps.listResults(deps.pool(), {
						id: c.req.valid("param").id,
						project_id: c.req.valid("query").project_id,
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_read",
						),
					}),
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleGetExperimentSummary: async (
			c: Parameters<RouteHandler<typeof getExperimentSummary>>[0],
		) => {
			try {
				return c.json(
					await deps.summary(deps.pool(), {
						id: c.req.valid("param").id,
						project_id: c.req.valid("query").project_id,
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_read",
						),
					}),
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleCancelExperiment: async (
			c: Parameters<RouteHandler<typeof cancelExperiment>>[0],
		) => {
			try {
				const id = c.req.valid("param").id;
				const project_id = c.req.valid("query").project_id;
				const cancelled = await deps.cancelExperiment(deps.pool(), {
					id,
					project_id,
					authorization: projectAuthorization(trustedTenant(c), "execute"),
				});
				activeExperiments.get(experimentKey(project_id, id))?.abort();
				return c.json(cancelled);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleGetExperimentEvents: async (
			c: Parameters<RouteHandler<typeof getExperimentEvents>>[0],
		) => {
			try {
				const params = c.req.valid("param");
				const query = c.req.valid("query");
				const authorization = projectAuthorization(
					trustedTenant(c),
					"product_read",
				);
				const initial = await deps.getExperiment(deps.pool(), {
					id: params.id,
					project_id: query.project_id,
					authorization,
				});
				return streamSSE(c, async (stream) => {
					let timer: ReturnType<typeof setInterval> | undefined;
					let closed = false;
					let polling = false;
					let resolveClose = () => {};
					const waitForClose = new Promise<void>((resolve) => {
						resolveClose = resolve;
					});
					const close = () => {
						if (closed) return;
						closed = true;
						if (timer) clearInterval(timer);
						resolveClose();
					};
					stream.onAbort(close);
					const frameDelivery = createAuthorizedSseDelivery({
						stream,
						pool: deps.pool,
						tenant: trustedTenant(c),
						projectId: initial.project_id,
						onClose: close,
					});
					const tick = async () => {
						if (closed || polling) return;
						polling = true;
						try {
							const row = await deps.getExperiment(deps.pool(), {
								id: params.id,
								project_id: query.project_id,
								authorization,
							});
							const data = JSON.stringify(row);
							if (
								!(await frameDelivery.deliver(
									authorizedSseFrame(data, () =>
										stream.writeSSE({ event: "experiment", data }),
									),
								))
							)
								return;
							if (["completed", "failed", "cancelled"].includes(row.status))
								close();
						} catch {
							if (!stream.aborted) {
								const data = JSON.stringify({
									code: "INTERNAL",
									message: "Evaluation event stream failed",
								});
								await frameDelivery.deliver(
									authorizedSseFrame(data, () =>
										stream.writeSSE({ event: "error", data }),
									),
								);
							}
							close();
						} finally {
							polling = false;
						}
					};
					if (
						!(await frameDelivery.deliver(
							authorizedSseFrame(":ok\n\n", () => stream.write(":ok\n\n")),
						))
					)
						return;
					timer = setInterval(() => void tick(), 500);
					void tick();
					await waitForClose;
				});
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
	};
}

export const {
	handleCreateExperiment,
	handleListExperiments,
	handleGetExperiment,
	handleGetExperimentResults,
	handleGetExperimentSummary,
	handleGetExperimentEvents,
	handleCancelExperiment,
} = createExperimentHandlers();
