import { randomUUID } from "node:crypto";
import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import {
	claimOptimizationJob,
	getActiveOptimizationJob,
	getOptimizationJob,
	createOptimizationJob,
	listOptimizationEvents,
	optimizationSourceMessages,
	publishOptimizationResult,
	renewOptimizationJobLease,
	stopOptimizationJob,
	transitionOptimizationJob,
	type OptimizationJob,
} from "../db/prompt-optimizations.js";
import { pgPool } from "../db/postgres.js";
import { PromptRepositoryError } from "../db/prompts.js";
import type { JsonObject } from "../db/prompts.js";
import {
	MAX_OPTIMIZATION_CANDIDATE_BYTES,
	runGepaWorker,
	type GepaWorker,
} from "../lib/gepa-worker.js";
import { hasMatchingMustacheTokenSignature } from "../lib/prompt-tokens.js";
import {
	GepaConfigurationError,
	MAX_GEPA_METRIC_CALLS,
	validateGepaConfiguration,
} from "../lib/gepa-config.js";
import { validatePromptTemplate } from "../lib/prompt-templates.js";
import { TRUSTED_ACTOR_CONTEXT_KEY } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";
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
	.object({
		max_metric_calls: z.number().int().positive().max(MAX_GEPA_METRIC_CALLS),
	})
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
			: cause instanceof GepaConfigurationError
				? new PromptRepositoryError("BAD_REQUEST", cause.message)
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
	claim: typeof claimOptimizationJob;
	renew: typeof renewOptimizationJobLease;
	sourceMessages: typeof optimizationSourceMessages;
	events: typeof listOptimizationEvents;
	stop: typeof stopOptimizationJob;
	transition: typeof transitionOptimizationJob;
	publish: typeof publishOptimizationResult;
};
const activeWorkers = new Map<string, AbortController>();
const workerId = randomUUID();
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

export function validateGepaCandidate(
	original: string,
	candidate: string,
): void {
	if (
		new TextEncoder().encode(candidate).byteLength >
		MAX_OPTIMIZATION_CANDIDATE_BYTES
	)
		throw new PromptRepositoryError(
			"BAD_REQUEST",
			"GEPA candidate exceeded size limit",
		);
	try {
		validatePromptTemplate(candidate);
	} catch (cause) {
		throw new PromptRepositoryError(
			"BAD_REQUEST",
			cause instanceof Error ? cause.message : "GEPA candidate is invalid",
		);
	}
	if (!hasMatchingMustacheTokenSignature(original, candidate))
		throw new PromptRepositoryError(
			"BAD_REQUEST",
			"GEPA candidate changed Mustache tokens",
		);
}

const production: OptimizationDependencies = {
	pool: pgPool,
	worker: runGepaWorker,
	create: createOptimizationJob,
	get: getOptimizationJob,
	getActive: getActiveOptimizationJob,
	claim: claimOptimizationJob,
	renew: renewOptimizationJobLease,
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
	if (activeWorkers.has(job.id)) {
		logger.debug("optimization.already_running", { job_id: job.id });
		return;
	}
	if (!(await d.claim(d.pool(), { id: job.id, worker_id: workerId }))) {
		logger.debug("optimization.claim_not_owned", { job_id: job.id });
		return;
	}
	const startedAt = performance.now();
	const controller = new AbortController();
	logger.info("optimization.claimed", {
		job_id: job.id,
		project_id: job.project_id,
		prompt_slug: job.prompt_slug,
		target: job.target,
		worker_id: workerId,
	});
	activeWorkers.set(job.id, controller);
	const leaseRenewal = setInterval(() => {
		void d
			.renew(d.pool(), { id: job.id, worker_id: workerId })
			.then((owned) => {
				if (!owned) controller.abort();
			});
	}, 60_000);
	try {
		await d.transition(d.pool(), {
			id: job.id,
			worker_id: workerId,
			status: "preparing",
		});
		logger.info("optimization.preparing", { job_id: job.id });
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
		await d.transition(d.pool(), {
			id: job.id,
			worker_id: workerId,
			status: "optimizing",
		});
		logger.info("optimization.worker_started", {
			job_id: job.id,
			target: job.target,
			models: job.model_config,
			max_metric_calls: job.budget,
		});
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
		logger.info("optimization.worker_completed", {
			job_id: job.id,
			duration_ms: Math.round(performance.now() - startedAt),
			score: result.score,
			candidate_bytes: new TextEncoder().encode(result.candidate).byteLength,
		});
		await d.transition(d.pool(), {
			id: job.id,
			worker_id: workerId,
			status: "evaluating",
		});
		validateGepaCandidate(original.content, result.candidate);
		await d.publish(d.pool(), {
			id: job.id,
			worker_id: workerId,
			messages: sourceMessages.map((item) =>
				item.role === job.target
					? { ...item, content: result.candidate }
					: item,
			),
		});
		logger.info("optimization.completed", {
			job_id: job.id,
			duration_ms: Math.round(performance.now() - startedAt),
		});
	} catch (cause) {
		logger.error("optimization.failed", cause, {
			job_id: job.id,
			project_id: job.project_id,
			prompt_slug: job.prompt_slug,
			duration_ms: Math.round(performance.now() - startedAt),
		});
		try {
			await d.transition(d.pool(), {
				id: job.id,
				worker_id: workerId,
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
		clearInterval(leaseRenewal);
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
				validateGepaConfiguration({
					model_config: body.model_config as {
						task_lm: string;
						reflection_lm: string;
					},
					budget: body.budget as { max_metric_calls: number },
				});
				const job = await d.create(d.pool(), { ...body, actor: actor(c) });
				logger.info("optimization.accepted", {
					job_id: job.id,
					project_id: job.project_id,
					prompt_slug: job.prompt_slug,
					source_version: job.source_version,
					target: job.target,
					models: body.model_config,
					budget: body.budget,
				});
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
				logger.info("optimization.stop_requested", { job_id: job.id });
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
