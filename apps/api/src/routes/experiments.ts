import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import { pgPool } from "../db/postgres.js";
import {
	cancelExperiment as cancelExperimentRecord,
	createExperiment as createExperimentRecord,
	experimentSummary as experimentSummaryRecord,
	ExperimentRepositoryError,
	getExperiment as getExperimentRecord,
	insertExperimentResult,
	listExperimentResults,
	listExperiments as listExperimentsRecord,
	updateExperiment,
} from "../db/experiments.js";
import { getDataset, listDatasetItems } from "../db/datasets.js";
import { createOtlpIngestHandler } from "./otlp.js";
import { invokeConfiguredLlm } from "../lib/llm.js";
import { scoreCase } from "../lib/evaluator.js";
import { logger } from "../lib/logger.js";
import {
	Experiment,
	ExperimentCreate,
	ExperimentErrorResponses,
	ExperimentIdParam,
	ExperimentProjectQuery,
	ExperimentList,
	ExperimentResults,
	ExperimentSummary,
} from "../schemas/experiments.js";

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
	traceResult = createOtlpIngestHandler(),
	pool = pgPool,
): ExperimentDependencies["trace"] {
	return async (input) => {
		const organization = await pool().query<{ organization_id: string }>(
			"SELECT organization_id FROM projects WHERE id = $1",
			[input.project_id],
		);
		const organizationId = organization.rows[0]?.organization_id;
		if (!organizationId) return;
		const response = await traceResult(
			new Request("http://internal/v1/otel/v1/traces", {
				method: "POST",
				body: JSON.stringify(createEvaluationTracePayload(input)),
				headers: { "content-type": "application/json" },
			}),
			{
				actor: "evaluation-worker",
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
	await deps.updateExperiment(db, {
		project_id: input.project_id,
		id: input.experiment_id,
		status: "running",
	});
	const dataset = await deps.listDatasetItems(db, {
		project_id: input.project_id,
		dataset_id: input.dataset_id,
	});
	const evaluator =
		input.config.evaluator === "contains" ? "contains" : "exact_match";
	for (const item of dataset.items) {
		if (signal?.aborted) {
			await deps.updateExperiment(db, {
				project_id: input.project_id,
				id: input.experiment_id,
				status: "cancelled",
			});
			return;
		}
		const current = await deps.getExperiment(db, {
			project_id: input.project_id,
			id: input.experiment_id,
		});
		if (current.status === "cancelled") return;
		const started = Date.now();
		try {
			const llm = await deps.invokeLlm(item.input, input.config, signal);
			const scores = scoreCase(evaluator, item.expected_output, llm.output);
			const duration_ms = Date.now() - started;
			await deps.insertResult(db, {
				experiment_id: input.experiment_id,
				dataset_item_id: item.id,
				output: llm.output,
				scores,
				duration_ms,
				status: scores[evaluator] === 1 ? "completed" : "failed",
				agent_version: llm.model,
			});
			try {
				await deps.trace({
					project_id: input.project_id,
					experiment_id: input.experiment_id,
					item_id: item.id,
					model: llm.model,
					input: item.input,
					output: JSON.stringify(llm.output),
					duration_ms,
				});
			} catch (traceError) {
				logger.warn("evaluation.trace_failed", {
					experiment_id: input.experiment_id,
					dataset_item_id: item.id,
					error_type:
						traceError instanceof Error ? traceError.name : typeof traceError,
				});
			}
		} catch {
			if (signal?.aborted) {
				await deps.updateExperiment(db, {
					project_id: input.project_id,
					id: input.experiment_id,
					status: "cancelled",
				});
				return;
			}
			const duration_ms = Date.now() - started;
			await deps.insertResult(db, {
				experiment_id: input.experiment_id,
				dataset_item_id: item.id,
				output: null,
				scores: { [evaluator]: 0 },
				duration_ms,
				status: "failed",
			});
			try {
				await deps.trace({
					project_id: input.project_id,
					experiment_id: input.experiment_id,
					item_id: item.id,
					model:
						typeof input.config.model === "string"
							? input.config.model
							: "configured-model",
					input: item.input,
					output: "evaluation_failed",
					duration_ms,
				});
			} catch (traceError) {
				logger.warn("evaluation.trace_failed", {
					experiment_id: input.experiment_id,
					dataset_item_id: item.id,
					error_type:
						traceError instanceof Error ? traceError.name : typeof traceError,
				});
			}
		}
	}
	const final = await deps.getExperiment(db, {
		project_id: input.project_id,
		id: input.experiment_id,
	});
	if (final.status === "cancelled" || signal?.aborted) {
		if (final.status !== "cancelled")
			await deps.updateExperiment(db, {
				project_id: input.project_id,
				id: input.experiment_id,
				status: "cancelled",
			});
		return;
	}
	await deps.updateExperiment(db, {
		project_id: input.project_id,
		id: input.experiment_id,
		status: "completed",
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
				const row = await deps.createExperiment(db, body);
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
				let cancelStream = () => {};
				const stream = new ReadableStream({
					start(controller) {
						let timer: ReturnType<typeof setInterval> | undefined;
						let closed = false;
						const close = () => {
							if (closed) return;
							closed = true;
							if (timer) clearInterval(timer);
							controller.close();
						};
						cancelStream = close;
						const tick = async () => {
							if (closed) return;
							try {
								const row = await deps.getExperiment(deps.pool(), {
									id: params.id,
									project_id: query.project_id,
								});
								if (closed) return;
								controller.enqueue(
									`event: experiment\ndata: ${JSON.stringify(row)}\n\n`,
								);
								if (["completed", "failed", "cancelled"].includes(row.status))
									close();
							} catch {
								close();
							}
						};
						timer = setInterval(() => void tick(), 500);
						void tick();
					},
					cancel() {
						cancelStream();
					},
				});
				return new Response(stream, {
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
					},
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
