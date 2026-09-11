import { describe, expect, it } from "bun:test";
import { compareEvaluationRuns } from "../../src/db/evaluation-runs";

const project_id = "11111111-1111-4111-8111-111111111111";
const left_id = "22222222-2222-4222-8222-222222222222";
const right_id = "33333333-3333-4333-8333-333333333333";
const definition_id = "44444444-4444-4444-8444-444444444444";
const dataset_id = "55555555-5555-4555-8555-555555555555";
const definition_hash = "a".repeat(64);
const dataset_hash = "b".repeat(64);

const authorization = {
	organization_id: "66666666-6666-4666-8666-666666666666",
	actor_id: "77777777-7777-4777-8777-777777777777",
	operation: "product_read",
};

function runRow(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		project_id,
		evaluation_id: "88888888-8888-4888-8888-888888888888",
		definition_version_id: definition_id,
		dataset_version_id: dataset_id,
		status: "completed",
		created_at: "2026-09-11T00:00:00.000Z",
		updated_at: "2026-09-11T00:01:00.000Z",
		terminal_reason: null,
		definition_content_hash: definition_hash,
		dataset_content_hash: dataset_hash,
		target_fingerprint: "c".repeat(64),
		evaluator_fingerprint: "d".repeat(64),
		sample_identity: "e".repeat(64),
		evaluator_version: "v1",
		evaluator: { kind: "exact_match" },
		execution_defaults: { temperature: 0 },
		limits: { max_cost_usd: 10, max_duration_seconds: 60 },
		total: 2,
		pending: 0,
		running: 0,
		completed: 2,
		failed: 0,
		cancelled: 0,
		evaluated: 2,
		passed: 1,
		evaluated_failed: 1,
		cost_usd: 1,
		duration_ms: 1000,
		total_count: 2,
		...overrides,
	};
}

function fakeDb(
	rows: Record<string, unknown>[],
	thresholds = [
		{ run_id: left_id, thresholds: { minimum_pass_rate: 0.5 } },
		{ run_id: right_id, thresholds: { minimum_pass_rate: 0.5 } },
	],
) {
	const queries: string[] = [];
	const client = {
		query: async (text: string) => {
			queries.push(text);
			if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK")
				return { rows: [] };
			if (text.includes("FROM projects p"))
				return { rows: [{ id: project_id }] };
			if (text.includes("authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			if (text.includes("FROM evaluation_runs run")) return { rows };
			if (text.includes("FROM evaluation_run_inputs"))
				return { rows: thresholds };
			return { rows: [] };
		},
		release() {},
	};
	return {
		db: { connect: async () => client },
		queries,
	};
}

describe("Evaluation Run comparison", () => {
	it("allows target changes while requiring immutable inputs to match", async () => {
		const fixture = fakeDb([
			runRow(left_id),
			runRow(right_id, { target_fingerprint: "f".repeat(64), passed: 2 }),
		]);
		const result = await compareEvaluationRuns(fixture.db as never, {
			project_id,
			run_ids: [left_id, right_id],
			authorization: authorization as never,
		});

		expect(result.comparable).toBe(true);
		expect(result.refusal).toBeNull();
		expect(result.metrics.delta).toEqual({
			pass_rate: 0.5,
			cost_usd: 0,
			duration_ms: 0,
		});
		expect(result.differences).toContainEqual({
			field: "target",
			left: "c".repeat(64),
			right: "f".repeat(64),
		});
		expect(fixture.queries.some((query) => query.includes(".replace"))).toBe(
			false,
		);
	});

	it("refuses a definition or dataset content-hash mismatch", async () => {
		const result = await compareEvaluationRuns(
			fakeDb([
				runRow(left_id),
				runRow(right_id, {
					definition_content_hash: "1".repeat(64),
					dataset_content_hash: "2".repeat(64),
				}),
			]).db as never,
			{
				project_id,
				run_ids: [left_id, right_id],
				authorization: authorization as never,
			},
		);

		expect(result.comparable).toBe(false);
		expect(result.refusal).toMatchObject({ code: "incompatible_inputs" });
		expect(result.metrics.delta).toBeNull();
		expect(result.differences.map((difference) => difference.field)).toEqual(
			expect.arrayContaining(["definition_version", "dataset_version"]),
		);
	});

	it("refuses non-success terminal runs without emitting deltas", async () => {
		const result = await compareEvaluationRuns(
			fakeDb([
				runRow(left_id),
				runRow(right_id, {
					status: "cancelled",
					terminal_reason: "cancelled_by_request",
				}),
			]).db as never,
			{
				project_id,
				run_ids: [left_id, right_id],
				authorization: authorization as never,
			},
		);

		expect(result.comparable).toBe(false);
		expect(result.refusal).toMatchObject({ code: "non_success_terminal" });
		expect(result.metrics.delta).toBeNull();
	});
});
