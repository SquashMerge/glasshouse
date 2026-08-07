import { describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { PromptRepositoryError } from "../../src/db/prompts";
import { logger } from "../../src/lib/logger";
import { TRUSTED_ACTOR_CONTEXT_KEY } from "../../src/middleware/auth";
import {
	createOptimizationHandlers,
	getOptimization,
	getLatestOptimization,
	listOptimizationActivities,
	startOptimization,
	type OptimizationDependencies,
} from "../../src/routes/prompt-optimizations";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";

const getLatest = mock(
	async (_pool: unknown, input: { project_id: string }) => {
		if (input.project_id === OTHER_PROJECT)
			throw new PromptRepositoryError("NOT_FOUND", "Project is not available");
		return null;
	},
);
const listActivities = mock(async () => [
	{
		id: "33333333-3333-4333-8333-333333333333",
		prompt_slug: "daily-summary",
		source_version: 2,
		target: "system" as const,
		status: "optimizing" as const,
		created_at: "2026-07-30T21:37:45.906Z",
		updated_at: "2026-07-30T21:38:00.000Z",
	},
]);

function privateJob(candidate_content = "Safe candidate {{tasks}}") {
	return {
		id: "33333333-3333-4333-8333-333333333333",
		project_id: PROJECT,
		prompt_id: "44444444-4444-4444-8444-444444444444",
		prompt_slug: "daily-summary",
		source_version: 2,
		target: "system" as const,
		evaluator: { type: "default_adapter" },
		dataset: {
			version: 1 as const,
			rubric: "Preserve deadlines.",
			training_examples: [
				{ input: "private training input", answer: "private training answer" },
			],
			validation_examples: [
				{
					input:
						"The confidential memo requires immediate approval before Friday noon.",
					answer: "private held-out answer",
				},
			],
		},
		dataset_hash: "a".repeat(64),
		model_config: { task_lm: "private-model" },
		budget: { max_metric_calls: 5 },
		status: "completed" as const,
		requested_by: "private-requester",
		result_version: null,
		candidate_content,
		evidence: null,
		promotion_status: "review_required" as const,
		promotion_reason: "insufficient_held_out_validation",
		reviewed_by: null,
		promoted_at: null,
		error_message: null,
		metric_calls_used: 3,
		created_at: "2026-07-30T21:37:45.906Z",
		updated_at: "2026-07-30T21:39:45.325Z",
		completed_at: "2026-07-30T21:39:45.325Z",
	};
}

const get = mock(async () => privateJob());

function app() {
	const handlers = createOptimizationHandlers({
		pool: () => ({}) as never,
		get,
		getLatest,
		listActivities,
	} as unknown as OptimizationDependencies);
	const api = new OpenAPIHono({
		defaultHook: (result, c) =>
			result.success
				? undefined
				: c.json(
						{ code: "BAD_REQUEST", message: "Request validation failed" },
						400,
					),
	});
	api.openapi(listOptimizationActivities, handlers.handleListActivities);
	api.openapi(getLatestOptimization, handlers.handleGetLatest);
	api.openapi(getOptimization, handlers.handleGet);
	return api;
}

describe("prompt optimization status routes", () => {
	it("rejects an impossible metric-call budget before creating a job", async () => {
		const create = mock(async () => privateJob());
		const handlers = createOptimizationHandlers({
			pool: () => ({}) as never,
			create,
		} as unknown as OptimizationDependencies);
		const api = new OpenAPIHono({
			defaultHook: (result, c) =>
				result.success
					? undefined
					: c.json(
							{ code: "BAD_REQUEST", message: "Request validation failed" },
							400,
						),
		});
		api.use("*", async (c, next) => {
			c.set(TRUSTED_ACTOR_CONTEXT_KEY, "test-user");
			await next();
		});
		api.openapi(startOptimization, handlers.handleStart);
		const originalModels = process.env.GEPA_ALLOWED_MODELS;
		process.env.GEPA_ALLOWED_MODELS = "local-model";
		try {
			const response = await api.request("/v1/prompt-optimizations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					project_id: PROJECT,
					slug: "daily-summary",
					source_version: 1,
					target: "system",
					evaluator: { type: "default_adapter" },
					dataset: {
						version: 1,
						rubric: "Preserve concise summaries.",
						training_examples: [
							{ input: "training input", answer: "training answer" },
						],
						validation_examples: [
							{ input: "alpha", answer: "held-out answer" },
							{ input: "bravo", answer: "held-out answer" },
							{ input: "charlie", answer: "held-out answer" },
						],
					},
					model_config: {
						task_lm: "local-model",
						reflection_lm: "local-model",
					},
					budget: { max_metric_calls: 2 },
				}),
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				code: "BAD_REQUEST",
				message:
					"budget.max_metric_calls must be at least the number of held-out validation examples",
			});
			expect(create).not.toHaveBeenCalled();
		} finally {
			process.env.GEPA_ALLOWED_MODELS = originalModels;
		}
	});

	it("returns only minimal active activity for the requested project", async () => {
		listActivities.mockClear();
		const response = await app().request(
			`/v1/prompt-optimizations/activities?project_id=${PROJECT}`,
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			items: [
				{
					id: "33333333-3333-4333-8333-333333333333",
					prompt_slug: "daily-summary",
					source_version: 2,
					target: "system",
					status: "optimizing",
					created_at: "2026-07-30T21:37:45.906Z",
					updated_at: "2026-07-30T21:38:00.000Z",
				},
			],
		});
		expect(JSON.stringify(body)).not.toContain("examples");
		expect(listActivities.mock.calls[0]?.[1]).toEqual({ project_id: PROJECT });
	});

	it("keeps the latest job lookup project-scoped", async () => {
		getLatest.mockClear();
		const response = await app().request(
			`/v1/prompt-optimizations/latest?project_id=${OTHER_PROJECT}&slug=daily-summary`,
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			code: "NOT_FOUND",
			message: "Project is not available",
		});
		expect(getLatest.mock.calls[0]?.[1]).toEqual({
			project_id: OTHER_PROJECT,
			slug: "daily-summary",
		});
	});

	it("does not expose examples or model configuration from the latest status route", async () => {
		getLatest.mockResolvedValueOnce({
			id: "33333333-3333-4333-8333-333333333333",
			project_id: PROJECT,
			prompt_id: "44444444-4444-4444-8444-444444444444",
			prompt_slug: "daily-summary",
			source_version: 2,
			target: "system",
			evaluator: { type: "default_adapter" },
			examples: [{ input: "private input", answer: "private answer" }],
			model_config: { task_lm: "private-model" },
			budget: { max_metric_calls: 5 },
			status: "completed",
			requested_by: "admin",
			result_version: 3,
			error_message: null,
			metric_calls_used: 3,
			created_at: "2026-07-30T21:37:45.906Z",
			updated_at: "2026-07-30T21:39:45.325Z",
			completed_at: "2026-07-30T21:39:45.325Z",
		});
		const response = await app().request(
			`/v1/prompt-optimizations/latest?project_id=${PROJECT}&slug=daily-summary`,
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			id: "33333333-3333-4333-8333-333333333333",
			metric_calls_used: 3,
		});
		expect(JSON.stringify(body)).not.toContain("private");
		expect(JSON.stringify(body)).not.toContain("requested_by");
	});

	it("does not expose held-out answers from a job response", async () => {
		get.mockClear();
		const response = await app().request(
			`/v1/prompt-optimizations/33333333-3333-4333-8333-333333333333?project_id=${PROJECT}`,
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			dataset: {
				version: 1,
				rubric: "Preserve deadlines.",
				training_example_count: 1,
				validation_example_count: 1,
			},
			candidate_content: "Safe candidate {{tasks}}",
		});
		const serialized = JSON.stringify(body);
		expect(body).not.toHaveProperty("dataset_hash");
		expect(serialized).not.toContain("private training input");
		expect(serialized).not.toContain("private training answer");
		expect(serialized).not.toContain(
			"The confidential memo requires immediate approval before Friday noon.",
		);
		expect(serialized).not.toContain("private held-out answer");
		expect(serialized).not.toContain("private-model");
		expect(serialized).not.toContain("private-requester");
		expect(get.mock.calls[0]?.[1]).toEqual({
			project_id: PROJECT,
			id: "33333333-3333-4333-8333-333333333333",
		});
	});

	it("documents a required optimization request body", () => {
		const api = new OpenAPIHono();
		api.openapi(startOptimization, async (c) => c.json({}, 202));
		const document = api.getOpenAPIDocument({
			openapi: "3.1.0",
			info: { title: "test", version: "1" },
		});

		expect(
			document.paths?.["/v1/prompt-optimizations"]?.post?.requestBody?.required,
		).toBe(true);
	});

	it("hides legacy candidates that copy protected example material", async () => {
		get.mockResolvedValueOnce(
			privateJob(
				"Summarize {{tasks}}. The confidential rnerno requires irnrnediate approval before Friday noon.",
			),
		);
		const response = await app().request(
			`/v1/prompt-optimizations/33333333-3333-4333-8333-333333333333?project_id=${PROJECT}`,
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ candidate_content: null });
		expect(JSON.stringify(body)).not.toContain("confidential rnerno");
	});

	it("logs the exception when an optimization start returns an internal error", async () => {
		const originalModels = process.env.GEPA_ALLOWED_MODELS;
		const originalLogger = logger.error;
		const errors: Array<{ event: string; cause: unknown; fields: unknown }> =
			[];
		process.env.GEPA_ALLOWED_MODELS = "local-model";
		logger.error = (event, cause, fields = {}) =>
			errors.push({ event, cause, fields });
		try {
			const handlers = createOptimizationHandlers({
				pool: () => ({}) as never,
				create: async () => {
					throw new Error("database connection lost");
				},
			} as unknown as OptimizationDependencies);
			const api = new OpenAPIHono({
				defaultHook: (result, c) =>
					result.success
						? undefined
						: c.json(
								{ code: "BAD_REQUEST", message: "Request validation failed" },
								400,
							),
			});
			api.use("*", async (c, next) => {
				c.set(TRUSTED_ACTOR_CONTEXT_KEY, "test-user");
				await next();
			});
			api.openapi(startOptimization, handlers.handleStart);

			const response = await api.request("/v1/prompt-optimizations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					project_id: PROJECT,
					slug: "daily-summary",
					source_version: 1,
					target: "system",
					evaluator: { type: "default_adapter" },
					dataset: {
						version: 1,
						rubric: "Preserve concise summaries.",
						training_examples: [
							{ input: "training input", answer: "training answer" },
						],
						validation_examples: [
							{ input: "held-out input", answer: "held-out answer" },
						],
					},
					model_config: {
						task_lm: "local-model",
						reflection_lm: "local-model",
					},
					budget: { max_metric_calls: 2 },
				}),
			});

			expect(response.status).toBe(500);
			expect(errors).toEqual([
				{
					event: "optimization.request_failed",
					cause: expect.objectContaining({
						message: "database connection lost",
					}),
					fields: {
						project_id: PROJECT,
						prompt_slug: "daily-summary",
						source_version: 1,
						target: "system",
					},
				},
			]);
		} finally {
			logger.error = originalLogger;
			process.env.GEPA_ALLOWED_MODELS = originalModels;
		}
	});
});
