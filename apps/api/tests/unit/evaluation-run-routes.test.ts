import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
	cancelEvaluationRunRoute,
	getEvaluationRunRoute,
	getEvaluationRunEventsRoute,
	retryEvaluationRunRoute,
	listEvaluationRunsRoute,
	compareEvaluationRunsRoute,
	getEvaluationRunEvidenceRoute,
	startEvaluationRunRoute,
} from "../../src/routes/evaluations";
import {
	createEvaluationGateApprovalRoute,
	getEvaluationGateApprovalRoute,
	listEvaluationGateApprovalHistoryRoute,
	getEvaluationGateRunRoute,
	listEvaluationGateApprovalsRoute,
	listEvaluationGateRunsRoute,
	revokeEvaluationGateApprovalRoute,
	startEvaluationGateRoute,
} from "../../src/routes/evaluation-gates";
import { createBenchmarkRunRoute } from "../../src/routes/benchmarks";
import { createExperiment } from "../../src/routes/experiments";
import {
	EvaluationGateApprovalCreate,
	EvaluationGateRunStart,
} from "../../src/schemas/evaluation-gates";
import {
	EvaluationRunStatus,
	EvaluationRunCompare,
	EvaluationRunCompareRequest,
	EvaluationRunEvidencePage,
} from "../../src/schemas/evaluations";
import { ErrorCode } from "../../src/schemas/common";
import {
	cancelEvaluationRun,
	getEvaluationRunStatus,
	retryEvaluationRun,
} from "../../src/db/evaluation-runs";
import {
	getAgentIntrospectionRoute,
	putAgentIntrospectionRoute,
} from "../../src/routes/agent-introspection";

describe("Evaluation Run lifecycle API", () => {
	const hash = "a".repeat(64);
	const pinned_inputs = {
		definition_version_id: "55555555-5555-4555-8555-555555555555",
		dataset_version_id: "66666666-6666-4666-8666-666666666666",
		resolved_inputs_hash: hash,
		target: { kind: "fixture" },
		target_version: "1",
		target_fingerprint: hash,
		evaluator: { kind: "exact_match" },
		evaluator_version: "1",
		evaluator_fingerprint: hash,
		execution_defaults: {},
		thresholds: {},
		limits: {},
		execution_bounds: {
			max_active_runs_per_project: 4,
			max_active_runs_per_actor: 2,
			max_cases: 100,
			max_provider_calls: 100,
		},
		sample: {
			strategy: "all",
			sample_size: 2,
			seed: 0,
			selected_count: 2,
			sample_identity: hash,
		},
		provenance: { items: 2, with_source_trace: 0, with_source_observation: 0 },
	};
	const metrics = {
		evaluated: 0,
		passed: 0,
		failed: 0,
		pass_rate: null,
		cost_usd: null,
		provider_calls_used: 0,
		max_provider_calls: 100,
		max_cost_usd: null,
		duration_ms: null,
		max_duration_seconds: null,
		score_counts: {},
	};
	const evidence_policy = {
		retention: "project_policy" as const,
		max_items: 100,
		max_field_bytes: 64_000,
		redaction: "bounded_json",
	};
	const itemEvidence = {
		input: { prompt: "redacted fixture" },
		expected_output: null,
		output: null,
		scores: {},
		provenance: {
			source_trace_id: null,
			source_observation_id: null,
			evaluation_trace_id: null,
		},
		agent_version: null,
		timing: { started_at: null, completed_at: null, duration_ms: null },
		redaction: {
			applied: false,
			bounded: true,
			fields: [],
			max_bytes: 64_000,
		},
	};
	it("documents bounded admission and no-persistence rejections for every run-start route", () => {
		const app = new OpenAPIHono();
		for (const route of [
			startEvaluationRunRoute,
			startEvaluationGateRoute,
			createBenchmarkRunRoute,
			createExperiment,
		])
			app.openapi(route, () => new Response());
		const document = app.getOpenAPIDocument({
			openapi: "3.0.0",
			info: { title: "test", version: "1" },
		});
		for (const operation of [
			document.paths?.["/v1/evaluations/{slug}/runs"]?.post,
			document.paths?.["/v1/evaluation-gates/runs"]?.post,
			document.paths?.["/v1/benchmarks/{id}/runs"]?.post,
			document.paths?.["/v1/experiments"]?.post,
		]) {
			expect(operation?.description).toContain("provider/model");
			expect(operation?.responses?.["400"]?.description).toContain(
				"before a runnable Run is persisted",
			);
			expect(operation?.responses?.["409"]?.description).toContain(
				"Idempotency-Key",
			);
			expect(operation?.responses?.["429"]?.description).toContain(
				"no runnable Run is persisted",
			);
		}
		expect(ErrorCode.safeParse("TOO_MANY_REQUESTS").success).toBe(true);
	});
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

	it("documents list, evidence pagination, and comparison contracts", () => {
		const app = new OpenAPIHono();
		for (const route of [
			listEvaluationRunsRoute,
			getEvaluationRunEvidenceRoute,
			compareEvaluationRunsRoute,
		])
			app.openapi(route, () => new Response());
		const document = app.getOpenAPIDocument({
			openapi: "3.0.0",
			info: { title: "test", version: "1" },
		});
		expect(document.paths?.["/v1/evaluation-runs"]?.get).toBeDefined();
		expect(
			document.paths?.["/v1/evaluation-runs/{id}/evidence"]?.get,
		).toBeDefined();
		expect(document.paths?.["/v1/evaluation-runs/compare"]?.post).toBeDefined();
		expect(
			EvaluationRunCompareRequest.safeParse({
				run_ids: [
					"11111111-1111-4111-8111-111111111111",
					"11111111-1111-4111-8111-111111111111",
				],
			}).success,
		).toBe(false);
		expect(
			EvaluationRunEvidencePage.safeParse({
				run_id: "11111111-1111-4111-8111-111111111111",
				project_id: "22222222-2222-4222-8222-222222222222",
				items: [],
				total: 0,
				next_offset: null,
			}).success,
		).toBe(true);
		expect(
			EvaluationRunCompare.safeParse({
				run_ids: [
					"11111111-1111-4111-8111-111111111111",
					"33333333-3333-4333-8333-333333333333",
				],
				comparable: false,
				differences: [],
				refusal: { code: "non_success_terminal", message: "not complete" },
				metrics: { left: metrics, right: metrics, delta: null },
			}).success,
		).toBe(true);
	});

	it("documents exact project-scoped agent introspection routes", () => {
		const app = new OpenAPIHono();
		app.openapi(putAgentIntrospectionRoute, () => new Response());
		app.openapi(getAgentIntrospectionRoute, () => new Response());
		const document = app.getOpenAPIDocument({
			openapi: "3.0.0",
			info: { title: "test", version: "1" },
		});
		const path =
			"/v1/evaluation-runs/{run_id}/tasks/{task_id}/agent-introspection/{invocation_id}";
		const put = document.paths?.[path]?.put;
		const get = document.paths?.[path]?.get;
		expect(put).toBeDefined();
		expect(get).toBeDefined();
		expect(put?.security).toEqual([{ basicAuth: [] }]);
		expect(get?.security).toEqual([{ basicAuth: [] }]);
		for (const operation of [put, get]) {
			expect(operation?.responses?.["401"]).toMatchObject({
				description: "Basic authentication required",
				headers: {
					"Cache-Control": { schema: { enum: ["no-store"] } },
				},
				content: {
					"application/json": {
						schema: { $ref: "#/components/schemas/ErrorEnvelope" },
					},
				},
			});
		}
		expect(put?.responses?.["422"]).toMatchObject({
			description: "Report violates the Agent Introspection contract",
			headers: {
				"Cache-Control": { schema: { enum: ["no-store"] } },
			},
			content: {
				"application/json": {
					schema: { $ref: "#/components/schemas/ErrorEnvelope" },
				},
			},
		});
		expect(
			document.components?.schemas?.ErrorEnvelope?.properties?.code?.enum,
		).toContain("CONTRACT_VIOLATION");
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
				pinned_inputs,
				metrics,
				evidence_policy,
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
			pinned_inputs,
			metrics,
			evidence_policy,
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
					...itemEvidence,
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
					...itemEvidence,
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
				if (text.startsWith("SELECT inputs.*, count(item.id)"))
					return {
						rows: [
							{
								target: { kind: "fixture" },
								target_version: "1",
								target_fingerprint: "a".repeat(64),
								evaluator: { kind: "exact_match" },
								evaluator_version: "1",
								evaluator_fingerprint: "a".repeat(64),
								execution_defaults: {},
								sampling: { strategy: "all", sample_size: 1, seed: 0 },
								thresholds: {},
								limits: {},
								execution_bounds: {
									max_active_runs_per_project: 4,
									max_active_runs_per_actor: 2,
									max_cases: 100,
									max_provider_calls: 100,
								},
								sample_identity: "a".repeat(64),
								resolved_inputs_hash: "a".repeat(64),
								definition_version_id: "55555555-5555-4555-8555-555555555555",
								dataset_version_id: "66666666-6666-4666-8666-666666666666",
								selected_count: 1,
								with_source_trace: 0,
								with_source_observation: 0,
							},
						],
					};
				if (text.startsWith("SELECT run.id, run.project_id"))
					return {
						rows: [
							{
								id: "run",
								project_id: "project",
								status: "cancelled",
								definition_version_id: "55555555-5555-4555-8555-555555555555",
								dataset_version_id: "66666666-6666-4666-8666-666666666666",
								resolved_inputs_hash: "a".repeat(64),
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
								agent_version: null,
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

	it("redacts nested KeyValue evidence and marks truncated collections", async () => {
		const snapshot = {
			target: { kind: "fixture" },
			target_version: "1",
			target_fingerprint: "a".repeat(64),
			evaluator: { kind: "exact_match" },
			evaluator_version: "1",
			evaluator_fingerprint: "a".repeat(64),
			execution_defaults: {},
			sampling: { strategy: "all", sample_size: 1, seed: 0 },
			thresholds: {},
			limits: {},
			execution_bounds: {
				max_active_runs_per_project: 4,
				max_active_runs_per_actor: 2,
				max_cases: 100,
				max_provider_calls: 100,
			},
			sample_identity: "a".repeat(64),
			resolved_inputs_hash: "a".repeat(64),
			definition_version_id: "55555555-5555-4555-8555-555555555555",
			dataset_version_id: "66666666-6666-4666-8666-666666666666",
			selected_count: 1,
			with_source_trace: 0,
			with_source_observation: 0,
		};
		const client = {
			query: async (text: string) => {
				if (
					text === "BEGIN" ||
					text === "COMMIT" ||
					text === "ROLLBACK" ||
					text.includes("FROM organization_memberships om") ||
					text.includes("FROM organization_actor_roles") ||
					text.includes("FROM project_memberships pm") ||
					text.includes("FROM project_actor_grants")
				)
					return { rows: [] };
				if (text.includes("FROM projects p WHERE p.id"))
					return { rows: [{ id: "project" }] };
				if (text.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (text.startsWith("SELECT v.redaction"))
					return {
						rows: [{ redaction: { mode: "none", keys: ["session_token"] } }],
					};
				if (text.startsWith("SELECT run.id, run.project_id"))
					return {
						rows: [
							{
								id: "run",
								project_id: "project",
								status: "completed",
								definition_version_id: snapshot.definition_version_id,
								dataset_version_id: snapshot.dataset_version_id,
								resolved_inputs_hash: snapshot.resolved_inputs_hash,
								created_at: "2026-09-10T00:00:00.000Z",
								updated_at: "2026-09-10T00:00:00.000Z",
								total: 1,
							},
						],
					};
				if (text.startsWith("SELECT inputs.*, count(item.id)"))
					return { rows: [snapshot] };
				if (text.startsWith("SELECT task.id AS task_id"))
					return {
						rows: [
							{
								task_id: "task",
								item_key: "item-1",
								position: 0,
								status: "completed",
								attempt_count: 1,
								input: {
									attributes: [
										{ key: "authorization", value: "top-secret" },
										{
											key: "nested",
											value: [
												{ key: "session_token", value: "configured-secret" },
											],
										},
									],
									overflow: Array.from({ length: 129 }, (_, index) => index),
								},
								output: Object.fromEntries(
									Array.from({ length: 129 }, (_, index) => [
										`field_${index}`,
										index,
									]),
								),
								error_classification: null,
								error_message: null,
								cost_usd: null,
								evaluator_rationale: null,
								trace_id: null,
								agent_version: null,
							},
						],
					};
				return { rows: [] };
			},
			release() {},
		};

		const status = await getEvaluationRunStatus(
			{ connect: async () => client } as never,
			{
				id: "run",
				project_id: "project",
				authorization: {
					organization_id: "organization",
					actor_id: "actor",
					operation: "product_read",
				},
			},
		);

		expect(status.items[0]?.input).toMatchObject({
			attributes: [
				{ key: "authorization", value: "[REDACTED]" },
				{
					key: "nested",
					value: [{ key: "session_token", value: "[REDACTED]" }],
				},
			],
		});
		expect(status.items[0]?.redaction).toMatchObject({
			applied: true,
			bounded: true,
		});
	});

	it("documents Admin-approved pinned gate contracts and rejects mutable inputs", () => {
		const app = new OpenAPIHono();
		for (const route of [
			createEvaluationGateApprovalRoute,
			listEvaluationGateApprovalsRoute,
			getEvaluationGateApprovalRoute,
			listEvaluationGateApprovalHistoryRoute,
			revokeEvaluationGateApprovalRoute,
			startEvaluationGateRoute,
			listEvaluationGateRunsRoute,
			getEvaluationGateRunRoute,
		])
			app.openapi(route, () => new Response());
		const document = app.getOpenAPIDocument({
			openapi: "3.0.0",
			info: { title: "test", version: "1" },
		});
		expect(
			document.paths?.["/v1/evaluation-gates/approvals"]?.post,
		).toBeDefined();
		expect(
			document.paths?.["/v1/evaluation-gates/approvals"]?.get,
		).toBeDefined();
		expect(
			document.paths?.["/v1/evaluation-gates/approvals/{id}/history"]?.get,
		).toBeDefined();
		expect(
			document.paths?.["/v1/evaluation-gates/approvals/{id}/revoke"]?.post,
		).toBeDefined();
		expect(document.paths?.["/v1/evaluation-gates/runs"]?.post).toBeDefined();
		expect(
			document.paths?.["/v1/evaluation-gates/runs/{id}"]?.get,
		).toBeDefined();
		expect(
			EvaluationGateApprovalCreate.safeParse({
				definition_version_id: "55555555-5555-4555-8555-555555555555",
				gate_context: "ci",
				reason: "approved immutable regression contract",
			}).success,
		).toBe(true);
		expect(
			EvaluationGateRunStart.safeParse({
				approval_id: "11111111-1111-4111-8111-111111111111",
				definition_version_id: "55555555-5555-4555-8555-555555555555",
				dataset_version_id: "66666666-6666-4666-8666-666666666666",
				gate_context: "release",
			}).success,
		).toBe(true);
		expect(
			EvaluationGateRunStart.safeParse({
				approval_id: "11111111-1111-4111-8111-111111111111",
				definition_version_id: "latest",
				dataset_version_id: "66666666-6666-4666-8666-666666666666",
				gate_context: "ci",
			}).success,
		).toBe(false);
	});
});
