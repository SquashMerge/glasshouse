import { createRoute, type RouteHandler, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getDataset, listDatasetItems } from "../db/datasets.js";
import {
	cancelExperiment as cancelExperimentRecord,
	claimExperimentTask,
	claimExperimentExecution,
	completeExperimentIfTasksFinished,
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
} from "../db/execution-admissions.js";
import { evaluationWorkerActorId } from "../db/actors.js";
import { projectAuthorization } from "../db/project-authorization.js";
import { pgPool } from "../db/postgres.js";
import { scoreCase } from "../lib/evaluator.js";
import { invokeConfiguredLlm } from "../lib/llm.js";
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
	security: [{ basicAuth: [] }],
	request: {
		body: { content: { "application/json": { schema: ExperimentCreate } } },
	},
	responses: {
		201: {
			description: "Experiment created",
			content: { "application/json": { schema: Experiment } },
		},
		...ExperimentErrorResponses,
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
	nextTaskRetryDelay: typeof nextExperimentTaskRetryDelay;
	waitForTaskRetry: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	finalizeTask: typeof finalizeExperimentTask;
	completeExperiment: typeof completeExperimentIfTasksFinished;
	admitExecution: typeof admitExperimentExecution;
	isAdmissionActive: typeof experimentExecutionAdmissionIsActive;
	cancelAdmission: typeof cancelExecutionAdmission;
	completeAdmission: typeof completeExecutionAdmission;
	claimExecution: typeof claimExperimentExecution;
	summary: typeof experimentSummaryRecord;
	listDatasetItems: typeof listDatasetItems;
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
	}) => Promise<void>;
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
							value: { stringValue: "astraea-evaluation" },
						},
						{
							key: "astraea.project.id",
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
		const response = await ingest(
			new Request("http://internal/v1/otel/v1/traces", {
				method: "POST",
				body: JSON.stringify(createEvaluationTracePayload(input)),
				headers: { "content-type": "application/json" },
			}),
			{
				actorId: evaluationWorkerActorId(organizationId),
				organizationId,
				projectId: input.project_id,
			},
		);
		if (!response.ok) throw new Error("OTLP trace ingestion failed");
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
	summary: experimentSummaryRecord,
	listDatasetItems,
	getDataset,
	invokeLlm: invokeConfiguredLlm,
	trace: createProductionTrace(),
};

const activeExperiments = new Map<string, AbortController>();
const experimentKey = (projectId: string, experimentId: string) =>
	`${projectId}:${experimentId}`;

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
				status: "cancelled",
				if_status: ["pending", "running"],
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
			const admission = await deps.admitExecution(db, {
				project_id: input.project_id,
				id: input.experiment_id,
				work_id: task.id,
				timeout_ms: executionAdmissionTimeoutMs(),
			});
			if (!admission) {
				await deps.updateExperiment(db, {
					project_id: input.project_id,
					id: input.experiment_id,
					status: "cancelled",
					if_status: ["pending", "running"],
				});
				return;
			}
			admissionId = admission.id;
			const provider = await invokeWithExecutionAdmission({
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
					}),
				cancel: () => deps.cancelAdmission(db, admission.id),
				invoke: (providerSignal) =>
					deps.invokeLlm(task.input, input.config, providerSignal),
			});
			if (!provider.admitted) {
				await deps.updateExperiment(db, {
					project_id: input.project_id,
					id: input.experiment_id,
					status: "cancelled",
					if_status: ["pending", "running"],
				});
				return;
			}
			const llm = provider.value;
			const scores = scoreCase(evaluator, task.expected_output, llm.output);
			const duration_ms = Date.now() - itemStarted;
			const finalized = await deps.finalizeTask(db, {
				project_id: input.project_id,
				experiment_id: input.experiment_id,
				task_id: task.id,
				lease_token: task.lease_token,
				output: llm.output,
				scores,
				duration_ms,
				status: scores[evaluator] === 1 ? "completed" : "failed",
				agent_version: llm.model,
				admission_id: admission.id,
			});
			if (!finalized) return;
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
						}),
					cancel: () => deps.cancelAdmission(db, admission.id),
					invoke: () =>
						deps.trace({
							project_id: input.project_id,
							experiment_id: input.experiment_id,
							item_id: task.dataset_item_id,
							model: llm.model,
							input: task.input,
							output: JSON.stringify(llm.output),
							duration_ms,
						}),
				});
				if (!traceAdmission.admitted) {
					await deps.updateExperiment(db, {
						project_id: input.project_id,
						id: input.experiment_id,
						status: "cancelled",
						if_status: ["pending", "running"],
					});
					return;
				}
			} catch (traceError) {
				logger.warn("evaluation.trace_failed", traceError, {
					experiment_id: input.experiment_id,
					dataset_item_id: task.dataset_item_id,
				});
			}
		} catch {
			if (signal?.aborted) {
				await deps.updateExperiment(db, {
					project_id: input.project_id,
					id: input.experiment_id,
					status: "cancelled",
					if_status: ["pending", "running"],
				});
				return;
			}
			const duration_ms = Date.now() - itemStarted;
			const finalized = await deps.finalizeTask(db, {
				project_id: input.project_id,
				experiment_id: input.experiment_id,
				task_id: task.id,
				lease_token: task.lease_token,
				output: null,
				scores: { [evaluator]: 0 },
				duration_ms,
				status: "failed",
				...(admissionId ? { admission_id: admissionId } : {}),
			});
			if (!finalized) return;
			try {
				if (!admissionId) return;
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
						}),
					cancel: () => deps.cancelAdmission(db, admissionId!),
					invoke: () =>
						deps.trace({
							project_id: input.project_id,
							experiment_id: input.experiment_id,
							item_id: task.dataset_item_id,
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
			status: "cancelled",
			if_status: ["pending", "running"],
		});
		return;
	}
	await deps.completeExperiment(db, {
		project_id: input.project_id,
		id: input.experiment_id,
	});
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
				await deps.getDataset(db, {
					project_id: body.project_id,
					id: body.dataset_id,
				});
				const dataset = await deps.listDatasetItems(db, {
					project_id: body.project_id,
					dataset_id: body.dataset_id,
				});
				if (dataset.items.some((item) => item.expected_output === null))
					throw new ExperimentRepositoryError(
						"CONFLICT",
						"Every dataset item needs expected output for this evaluator",
					);
				const row = await deps.createExperiment(db, {
					...body,
					authorization: projectAuthorization(trustedTenant(c), "execute"),
				});
				const controller = new AbortController();
				activeExperiments.set(
					experimentKey(body.project_id, row.id),
					controller,
				);
				void executeExperiment(
					deps,
					{
						project_id: body.project_id,
						experiment_id: row.id,
						dataset_id: body.dataset_id,
						config: body.config,
					},
					controller.signal,
				)
					.catch(async (cause) => {
						logger.error("evaluation.failed", cause, {
							experiment_id: row.id,
							project_id: body.project_id,
						});
						await deps.updateExperiment(deps.pool(), {
							project_id: body.project_id,
							id: row.id,
							status: controller.signal.aborted ? "cancelled" : "failed",
							if_status: controller.signal.aborted
								? ["pending", "running"]
								: ["pending", "running"],
						});
					})
					.finally(() =>
						activeExperiments.delete(experimentKey(body.project_id, row.id)),
					);
				return c.json(row, 201);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleListExperiments: async (
			c: Parameters<RouteHandler<typeof listExperiments>>[0],
		) => {
			try {
				return c.json(
					await deps.listExperiments(
						deps.pool(),
						c.req.valid("query").project_id,
					),
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
						projectId: query.project_id,
						onClose: close,
					});
					const tick = async () => {
						if (closed || polling) return;
						polling = true;
						try {
							const row = await deps.getExperiment(deps.pool(), {
								id: params.id,
								project_id: query.project_id,
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
