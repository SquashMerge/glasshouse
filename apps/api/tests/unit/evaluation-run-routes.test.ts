import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
	cancelEvaluationRunRoute,
	getEvaluationRunRoute,
	getEvaluationRunEventsRoute,
	retryEvaluationRunRoute,
} from "../../src/routes/evaluations";
import { EvaluationRunStatus } from "../../src/schemas/evaluations";
import {
	cancelEvaluationRun,
	retryEvaluationRun,
} from "../../src/db/evaluation-runs";

describe("Evaluation Run lifecycle API", () => {
	it("documents authorized status, cancellation, retry, and replayable SSE routes", () => {
		const app = new OpenAPIHono();
		for (const route of [
			getEvaluationRunRoute,
			cancelEvaluationRunRoute,
			retryEvaluationRunRoute,
			getEvaluationRunEventsRoute,
		])
			app.openapi(route, () => new Response());
		const document = app.getOpenAPIDocument({
			openapi: "3.0.0",
			info: { title: "test", version: "1" },
		});

		expect(document.paths?.["/v1/evaluation-runs/{id}"]?.get).toBeDefined();
		expect(
			document.paths?.["/v1/evaluation-runs/{id}/cancel"]?.post,
		).toBeDefined();
		expect(
			document.paths?.["/v1/evaluation-runs/{id}/retry"]?.post,
		).toBeDefined();
		expect(
			document.paths?.["/v1/evaluation-runs/{id}/events"]?.get,
		).toBeDefined();
	});

	it("requires a project-scoped lifecycle status without exposing input content", () => {
		expect(
			EvaluationRunStatus.safeParse({
				id: "11111111-1111-4111-8111-111111111111",
				project_id: "22222222-2222-4222-8222-222222222222",
				status: "running",
				counts: {
					total: 2,
					pending: 0,
					running: 1,
					completed: 1,
					failed: 0,
					cancelled: 0,
				},
				created_at: "2026-09-10T00:00:00.000Z",
				updated_at: "2026-09-10T00:00:00.000Z",
			}).success,
		).toBe(true);
	});

	it("exposes bounded project-scoped per-item terminal evidence", () => {
		const parsed = EvaluationRunStatus.safeParse({
			id: "11111111-1111-4111-8111-111111111111",
			project_id: "22222222-2222-4222-8222-222222222222",
			status: "failed",
			counts: {
				total: 2,
				pending: 0,
				running: 0,
				completed: 0,
				failed: 1,
				cancelled: 1,
			},
			attempts: 2,
			created_at: "2026-09-10T00:00:00.000Z",
			updated_at: "2026-09-10T00:00:00.000Z",
			terminal_reason: "task_failed",
			items: [
				{
					task_id: "33333333-3333-4333-8333-333333333333",
					item_key: "first",
					position: 0,
					status: "failed",
					attempt_count: 2,
					error_classification: "cost_limit_exceeded",
					error_message: "evaluation cost limit exceeded",
					cost_usd: 1.25,
					evaluator_rationale: { kind: "exact_match", score: 0 },
					trace_id: "trace-1",
				},
				{
					task_id: "44444444-4444-4444-8444-444444444444",
					item_key: "second",
					position: 1,
					status: "cancelled",
					attempt_count: 1,
					error_classification: "cancelled_by_request",
					error_message: "evaluation run cancelled",
					cost_usd: null,
					evaluator_rationale: null,
					trace_id: null,
				},
			],
			items_truncated: false,
		});

		expect(parsed.success).toBe(true);
	});

	it("does not reset an uncertain provider dispatch during retry", async () => {
		const calls: string[] = [];
		const client = {
			query: async (text: string) => {
				calls.push(text);
				if (text.includes("FROM projects p"))
					return { rows: [{ id: "project" }] };
				if (text.includes("authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (text.startsWith("SELECT * FROM evaluation_runs"))
					return { rows: [{ status: "failed" }] };
				if (text.startsWith("UPDATE experiment_tasks")) return { rows: [] };
				return { rows: [] };
			},
			release() {},
		};
		const db = { connect: async () => client };

		await expect(
			retryEvaluationRun(db as never, {
				id: "11111111-1111-4111-8111-111111111111",
				project_id: "22222222-2222-4222-8222-222222222222",
				authorization: {
					organization_id: "33333333-3333-4333-8333-333333333333",
					actor_id: "44444444-4444-4444-8444-444444444444",
					operation: "execute",
				},
			}),
		).rejects.toMatchObject({ status: 409 });
		const reset = calls.find((text) =>
			text.startsWith("UPDATE experiment_tasks"),
		);
		expect(reset).toContain("last_error_classification = 'provider_error'");
	});

	it("returns bounded cancellation evidence instead of an empty items array", async () => {
		const calls: string[] = [];
		const client = {
			query: async (text: string) => {
				calls.push(text);
				if (text.includes("FROM projects p") && text.includes("FOR UPDATE"))
					return { rows: [{ id: "project" }] };
				if (text.includes("authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (text.startsWith("SELECT id FROM experiments"))
					return { rows: [{ id: "experiment" }] };
				if (text.startsWith("SELECT * FROM evaluation_runs"))
					return {
						rows: [{ id: "run", project_id: "project", status: "running" }],
					};
				if (text.startsWith("SELECT run.id, run.project_id"))
					return {
						rows: [
							{
								id: "run",
								project_id: "project",
								status: "cancelled",
								created_at: "2026-09-10T00:00:00.000Z",
								updated_at: "2026-09-10T00:00:00.000Z",
								terminal_reason: "cancelled_by_request",
								total: 1,
								cancelled: 1,
							},
						],
					};
				if (text.startsWith("SELECT task.id AS task_id"))
					return {
						rows: [
							{
								task_id: "task",
								item_key: "item-1",
								position: 0,
								status: "cancelled",
								attempt_count: 1,
								error_classification: "cancelled_by_request",
								error_message: "evaluation run cancelled",
								cost_usd: null,
								evaluator_rationale: null,
								trace_id: null,
							},
						],
					};
				return { rows: [] };
			},
			release() {},
		};

		const status = await cancelEvaluationRun(
			{ connect: async () => client } as never,
			{
				id: "run",
				project_id: "project",
				authorization: {
					organization_id: "organization",
					actor_id: "actor",
					operation: "execute",
				},
			},
		);

		expect(status.items).toHaveLength(1);
		expect(status.items[0]).toMatchObject({
			task_id: "task",
			status: "cancelled",
			error_classification: "cancelled_by_request",
		});
		expect(
			calls.findIndex((text) => text.startsWith("SELECT id FROM experiments")),
		).toBeLessThan(
			calls.findIndex((text) =>
				text.startsWith("SELECT * FROM evaluation_runs"),
			),
		);
	});
});
