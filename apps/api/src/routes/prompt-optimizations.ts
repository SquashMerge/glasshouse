import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import {
	getActiveOptimizationJob,
	getOptimizationJob,
	createOptimizationJob,
	listOptimizationEvents,
	optimizationSourceMessages,
	publishOptimizationResult,
	stopOptimizationJob,
	transitionOptimizationJob,
	type OptimizationJob,
} from "../db/prompt-optimizations.js";
import { pgPool } from "../db/postgres.js";
import { PromptRepositoryError } from "../db/prompts.js";
import type { JsonObject } from "../db/prompts.js";
import { runGepaWorker, type GepaWorker } from "../lib/gepa-worker.js";
import { hasMatchingMustacheTokenSignature } from "../lib/prompt-tokens.js";
import { TRUSTED_ACTOR_CONTEXT_KEY } from "../middleware/auth.js";
import {
	PromptErrorResponses,
	ProjectIdQuery,
	PromptId,
} from "../schemas/prompts.js";

const tag = "prompt-optimization";
const Status = z.enum([
	"queued",
	"preparing",
	"optimizing",
	"evaluating",
	"completed",
	"stopped",
	"failed",
]);
const JsonObject = z.record(z.string(), z.unknown());
const Evaluator = z.object({ type: z.literal("default_adapter") }).strict();
const Example = z
	.object({
		input: z.string().min(1),
		answer: z.string().min(1),
		additional_context: JsonObject.optional(),
	})
	.strict();
const ModelConfig = z
	.object({ task_lm: z.string().min(1), reflection_lm: z.string().min(1) })
	.strict();
const Budget = z
	.object({ max_metric_calls: z.number().int().positive() })
	.strict();
const Job = z
	.object({
		id: z.string().uuid(),
		project_id: z.string().uuid(),
		prompt_id: z.string().uuid(),
		prompt_slug: PromptId,
		source_version: z.number().int().positive(),
		target: z.enum(["system", "user"]),
		evaluator: JsonObject,
		examples: z.array(z.unknown()),
		model_config: JsonObject,
		budget: JsonObject,
		status: Status,
		requested_by: z.string(),
		result_version: z.number().int().positive().nullable(),
		error_message: z.string().nullable(),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
	})
	.strict();
const JobId = z
	.object({
		id: z
			.string()
			.uuid()
			.openapi({ param: { name: "id", in: "path" } }),
	})
	.strict();
const ActiveQuery = z
	.object({ project_id: z.string().uuid(), slug: PromptId })
	.strict();
const Start = z
	.object({
		project_id: z.string().uuid(),
		slug: PromptId,
		source_version: z.number().int().positive(),
		target: z.enum(["system", "user"]),
		evaluator: Evaluator,
		examples: z.array(Example).min(1),
		model_config: ModelConfig,
		budget: Budget,
	})
	.strict();
export const startOptimization = createRoute({
	method: "post",
	path: "/v1/prompt-optimizations",
	tags: [tag],
	summary: "Start a GEPA prompt optimization",
	security: [{ basicAuth: [] }],
	request: { body: { content: { "application/json": { schema: Start } } } },
	responses: {
		202: {
			description: "Queued",
			content: { "application/json": { schema: Job } },
		},
		...PromptErrorResponses,
	},
});
export const getOptimization = createRoute({
	method: "get",
	path: "/v1/prompt-optimizations/{id}",
	tags: [tag],
	security: [{ basicAuth: [] }],
	request: { params: JobId, query: ProjectIdQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Job } },
		},
		...PromptErrorResponses,
	},
});
export const getActiveOptimization = createRoute({
	method: "get",
	path: "/v1/prompt-optimizations/active",
	tags: [tag],
	security: [{ basicAuth: [] }],
	request: { query: ActiveQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Job.nullable() } },
		},
		...PromptErrorResponses,
	},
});
export const stopOptimization = createRoute({
	method: "post",
	path: "/v1/prompt-optimizations/{id}/stop",
	tags: [tag],
	security: [{ basicAuth: [] }],
	request: { params: JobId, query: ProjectIdQuery },
	responses: {
		200: {
			description: "Stopped",
			content: { "application/json": { schema: Job } },
		},
		...PromptErrorResponses,
	},
});
export const optimizationEvents = createRoute({
	method: "get",
	path: "/v1/prompt-optimizations/{id}/events",
	tags: [tag],
	security: [{ basicAuth: [] }],
	request: { params: JobId, query: ProjectIdQuery },
	responses: {
		200: {
			description: "SSE events",
			content: { "text/event-stream": { schema: z.string() } },
		},
		...PromptErrorResponses,
	},
});
function error(
	c: { json: (body: unknown, status: 400 | 404 | 409 | 500) => Response },
	cause: unknown,
): Response {
	const known =
		cause instanceof PromptRepositoryError
			? cause
			: new PromptRepositoryError("INTERNAL", "Optimization failed");
	return c.json(
		{
			code: known.code,
			message:
				known.code === "INTERNAL" ? "Optimization failed" : known.message,
		},
		known.status,
	);
}
function actor(c: { get: (key: string) => unknown }): string {
	const value = c.get(TRUSTED_ACTOR_CONTEXT_KEY);
	if (typeof value !== "string")
		throw new PromptRepositoryError("INTERNAL", "Trusted actor is unavailable");
	return value;
}
export type OptimizationDependencies = {
	pool: typeof pgPool;
	worker: GepaWorker;
	create: typeof createOptimizationJob;
	get: typeof getOptimizationJob;
	getActive: typeof getActiveOptimizationJob;
	sourceMessages: typeof optimizationSourceMessages;
	events: typeof listOptimizationEvents;
	stop: typeof stopOptimizationJob;
	transition: typeof transitionOptimizationJob;
	publish: typeof publishOptimizationResult;
};
const activeWorkers = new Map<string, AbortController>();
const terminalStatuses = new Set<OptimizationJob["status"]>([
	"completed",
	"stopped",
	"failed",
]);

export function nextOptimizationEvents(
	events: Awaited<ReturnType<typeof listOptimizationEvents>>,
	lastId: number,
): {
	events: Awaited<ReturnType<typeof listOptimizationEvents>>;
	lastId: number;
	terminal: boolean;
} {
	const unseen = [] as Awaited<ReturnType<typeof listOptimizationEvents>>;
	let terminal = false;
	for (const event of events) {
		if (event.id <= lastId) continue;
		unseen.push(event);
		if (terminalStatuses.has(event.status)) {
			terminal = true;
			break;
		}
	}
	return {
		events: unseen,
		lastId: unseen.at(-1)?.id ?? lastId,
		terminal,
	};
}

const production: OptimizationDependencies = {
	pool: pgPool,
	worker: runGepaWorker,
	create: createOptimizationJob,
	get: getOptimizationJob,
	getActive: getActiveOptimizationJob,
	sourceMessages: optimizationSourceMessages,
	events: listOptimizationEvents,
	stop: stopOptimizationJob,
	transition: transitionOptimizationJob,
	publish: publishOptimizationResult,
};

async function run(
	job: OptimizationJob,
	d: OptimizationDependencies,
): Promise<void> {
	if (activeWorkers.has(job.id)) return;
	const controller = new AbortController();
	activeWorkers.set(job.id, controller);
	try {
		await d.transition(d.pool(), { id: job.id, status: "preparing" });
		const sourceMessages = await d.sourceMessages(d.pool(), {
			project_id: job.project_id,
			id: job.id,
		});
		const original = sourceMessages.find((item) => item.role === job.target);
		if (!original)
			throw new PromptRepositoryError(
				"BAD_REQUEST",
				`Source prompt has no ${job.target} message`,
			);
		await d.transition(d.pool(), { id: job.id, status: "optimizing" });
		const result = await d.worker(
			{
				target: job.target,
				source: original.content,
				evaluator: job.evaluator,
				examples: job.examples,
				model_config: job.model_config,
				budget: job.budget,
			},
			controller.signal,
		);
		await d.transition(d.pool(), { id: job.id, status: "evaluating" });
		if (!hasMatchingMustacheTokenSignature(original.content, result.candidate))
			throw new PromptRepositoryError(
				"BAD_REQUEST",
				"GEPA candidate changed Mustache tokens",
			);
		await d.publish(d.pool(), {
			id: job.id,
			messages: sourceMessages.map((item) =>
				item.role === job.target
					? { ...item, content: result.candidate }
					: item,
			),
		});
	} catch (cause) {
		try {
			await d.transition(d.pool(), {
				id: job.id,
				status: "failed",
				error_message:
					cause instanceof Error
						? cause.message.slice(0, 240)
						: "Worker failed",
			});
		} catch {
			// A stopped job is terminal and wins every worker failure race.
		}
	} finally {
		if (activeWorkers.get(job.id) === controller) activeWorkers.delete(job.id);
	}
}
export function createOptimizationHandlers(
	d: OptimizationDependencies = production,
) {
	return {
		handleStart: async (
			c: Parameters<RouteHandler<typeof startOptimization>>[0],
		): Promise<Response> => {
			try {
				const body = c.req.valid("json") as {
					project_id: string;
					slug: string;
					source_version: number;
					target: "system" | "user";
					evaluator: JsonObject;
					examples: unknown[];
					model_config: JsonObject;
					budget: JsonObject;
				};
				const job = await d.create(d.pool(), { ...body, actor: actor(c) });
				void run(job, d);
				return c.json(job, 202);
			} catch (cause) {
				return error(c, cause);
			}
		},
		handleGet: async (
			c: Parameters<RouteHandler<typeof getOptimization>>[0],
		): Promise<Response> => {
			try {
				return c.json(
					await d.get(d.pool(), {
						project_id: (c.req.valid("query") as { project_id: string })
							.project_id,
						id: (c.req.valid("param") as { id: string }).id,
					}),
				);
			} catch (cause) {
				return error(c, cause);
			}
		},
		handleGetActive: async (
			c: Parameters<RouteHandler<typeof getActiveOptimization>>[0],
		): Promise<Response> => {
			try {
				return c.json(
					await d.getActive(
						d.pool(),
						c.req.valid("query") as { project_id: string; slug: string },
					),
				);
			} catch (cause) {
				return error(c, cause);
			}
		},
		handleStop: async (
			c: Parameters<RouteHandler<typeof stopOptimization>>[0],
		): Promise<Response> => {
			try {
				const job = await d.stop(d.pool(), {
					project_id: (c.req.valid("query") as { project_id: string })
						.project_id,
					id: (c.req.valid("param") as { id: string }).id,
				});
				activeWorkers.get(job.id)?.abort();
				return c.json(job);
			} catch (cause) {
				return error(c, cause);
			}
		},
		handleEvents: async (
			c: Parameters<RouteHandler<typeof optimizationEvents>>[0],
		): Promise<Response> => {
			try {
				const input = {
					project_id: (c.req.valid("query") as { project_id: string })
						.project_id,
					id: (c.req.valid("param") as { id: string }).id,
				};
				await d.get(d.pool(), input);
				return streamSSE(c, async (stream) => {
					let last = 0;
					try {
						while (!stream.aborted) {
							const next = nextOptimizationEvents(
								await d.events(d.pool(), input),
								last,
							);
							last = next.lastId;
							for (const event of next.events) {
								await stream.writeSSE({
									event: "status",
									id: String(event.id),
									data: JSON.stringify(event),
								});
							}
							if (next.terminal) return;
							await new Promise((resolve) => setTimeout(resolve, 500));
						}
					} catch {
						if (!stream.aborted)
							await stream.writeSSE({
								event: "error",
								data: JSON.stringify({
									code: "INTERNAL",
									message: "Optimization event stream failed",
								}),
							});
					}
				});
			} catch (cause) {
				return error(c, cause);
			}
		},
	};
}
export const {
	handleStart,
	handleGet,
	handleGetActive,
	handleStop,
	handleEvents,
} = createOptimizationHandlers();
