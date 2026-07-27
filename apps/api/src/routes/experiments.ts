import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import { pgPool } from "../db/postgres.js";
import {
	createExperiment as createExperimentRecord,
	experimentSummary as experimentSummaryRecord,
	ExperimentRepositoryError,
	getExperiment as getExperimentRecord,
	insertExperimentResult,
	listExperimentResults,
	listExperiments as listExperimentsRecord,
	updateExperiment,
} from "../db/experiments.js";
import { listDatasetItems } from "../db/datasets.js";
import { createOtlpIngestHandler } from "./otlp.js";
import { invokeConfiguredLlm } from "../lib/llm.js";
import { scoreCase } from "../lib/evaluator.js";
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
	listResults: typeof listExperimentResults;
	insertResult: typeof insertExperimentResult;
	summary: typeof experimentSummaryRecord;
	listDatasetItems: typeof listDatasetItems;
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

const traceResult = createOtlpIngestHandler();
const production: ExperimentDependencies = {
	pool: pgPool,
	createExperiment: createExperimentRecord,
	listExperiments: listExperimentsRecord,
	getExperiment: getExperimentRecord,
	updateExperiment,
	listResults: listExperimentResults,
	insertResult: insertExperimentResult,
	summary: experimentSummaryRecord,
	listDatasetItems,
	invokeLlm: invokeConfiguredLlm,
	trace: async (input) => {
		const traceId = crypto.randomUUID().replaceAll("-", "");
		const spanId = traceId.slice(0, 16);
		const start =
			BigInt(Date.now()) * 1_000_000n - BigInt(input.duration_ms) * 1_000_000n;
		const end = BigInt(Date.now()) * 1_000_000n;
		await traceResult(
			new Request("http://internal/v1/otel/v1/traces", {
				method: "POST",
				body: JSON.stringify({
					resource_spans: [
						{
							resource: {
								attributes: [
									{
										key: "service.name",
										value: { string_value: "astraea-evaluation" },
									},
									{
										key: "astraea.project.id",
										value: { string_value: input.project_id },
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
													value: { string_value: input.model },
												},
												{
													key: "input.value",
													value: { string_value: JSON.stringify(input.input) },
												},
												{
													key: "output.value",
													value: { string_value: input.output },
												},
											],
										},
									],
								},
							],
						},
					],
				}),
				headers: { "content-type": "application/json" },
			}),
		);
	},
};

export async function executeExperiment(
	deps: ExperimentDependencies,
	input: {
		project_id: string;
		experiment_id: string;
		dataset_id: string;
		config: Record<string, unknown>;
	},
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
		const started = Date.now();
		try {
			const llm = await deps.invokeLlm(item.input, input.config);
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
			} catch {
				// A trace sink outage must not duplicate an already-persisted result.
			}
		} catch {
			await deps.insertResult(db, {
				experiment_id: input.experiment_id,
				dataset_item_id: item.id,
				output: null,
				scores: { [evaluator]: 0 },
				duration_ms: Date.now() - started,
				status: "failed",
			});
		}
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
				const row = await deps.createExperiment(deps.pool(), body);
				void executeExperiment(deps, {
					project_id: body.project_id,
					experiment_id: row.id,
					dataset_id: body.dataset_id,
					config: body.config,
				}).catch(async () => {
					await deps.updateExperiment(deps.pool(), {
						project_id: body.project_id,
						id: row.id,
						status: "failed",
					});
				});
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
				return c.json(
					await deps.updateExperiment(deps.pool(), {
						id: c.req.valid("param").id,
						project_id: c.req.valid("query").project_id,
						status: "cancelled",
					}),
				);
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
				const stream = new ReadableStream({
					start(controller) {
						let timer: ReturnType<typeof setInterval> | undefined;
						const tick = async () => {
							try {
								const row = await deps.getExperiment(deps.pool(), {
									id: params.id,
									project_id: query.project_id,
								});
								controller.enqueue(
									`event: experiment\ndata: ${JSON.stringify(row)}\n\n`,
								);
								if (["completed", "failed", "cancelled"].includes(row.status)) {
									if (timer) clearInterval(timer);
									controller.close();
								}
							} catch {
								if (timer) clearInterval(timer);
								controller.close();
							}
						};
						void tick();
						timer = setInterval(() => void tick(), 500);
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
