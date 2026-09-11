import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createEvaluation,
	getEvaluation,
	getEvaluationDraft,
	getEvaluationVersion,
	listEvaluationRuns,
	getEvaluationRunEvidence,
	compareEvaluationRuns,
	listEvaluationVersions,
	updateEvaluationDraft,
} from "../../src/lib/api";
import { setCredentials } from "../../src/lib/auth";

const project_id = "11111111-1111-4111-8111-111111111111";
const definition = {
	dataset_version_id: "22222222-2222-4222-8222-222222222222",
	sampling: { strategy: "first_n" as const, sample_size: 1, seed: 0 },
	evaluator: {
		kind: "exact_match" as const,
		version: "v1" as const,
		expected_output_path: "$.expected_output",
		output_path: "$.output",
	},
	target: { kind: "configured_llm" as const, model: null, system_prompt: null },
	execution_defaults: { temperature: 0, max_tokens: null },
	limits: { max_cost_usd: 1, max_duration_seconds: 1 },
	thresholds: { minimum_pass_rate: null },
};
const json = () =>
	new Response(JSON.stringify({}), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

describe("evaluation API client contract", () => {
	const fetchMock = vi.fn();
	beforeEach(() => {
		setCredentials("admin", "secret");
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockImplementation(() => Promise.resolve(json()));
	});
	afterEach(() => vi.unstubAllGlobals());
	it("uses query-scoped create and stable slug detail/draft/version paths", async () => {
		await createEvaluation({
			project_id,
			slug: "quality-check",
			name: "Quality",
			definition,
		});
		await getEvaluation({ project_id, slug: "quality-check" });
		await getEvaluationDraft({ project_id, slug: "quality-check" });
		await updateEvaluationDraft({
			project_id,
			slug: "quality-check",
			revision: 2,
			definition,
		});
		await listEvaluationVersions({ project_id, slug: "quality-check" });
		await getEvaluationVersion({
			project_id,
			slug: "quality-check",
			version: 1,
		});
		expect(
			fetchMock.mock.calls.map(([url, init]) => ({
				url,
				method: init?.method ?? "GET",
				body: init?.body,
				etag: new Headers(init?.headers).get("if-match") ?? undefined,
			})),
		).toEqual([
			{
				url: `/v1/evaluations?project_id=${project_id}`,
				method: "POST",
				body: JSON.stringify({
					slug: "quality-check",
					name: "Quality",
					definition,
				}),
				etag: undefined,
			},
			{
				url: `/v1/evaluations/quality-check?project_id=${project_id}`,
				method: "GET",
				body: undefined,
				etag: undefined,
			},
			{
				url: `/v1/evaluations/quality-check/draft?project_id=${project_id}`,
				method: "GET",
				body: undefined,
				etag: undefined,
			},
			{
				url: `/v1/evaluations/quality-check/draft?project_id=${project_id}`,
				method: "PUT",
				body: JSON.stringify(definition),
				etag: '"2"',
			},
			{
				url: `/v1/evaluations/quality-check/versions?project_id=${project_id}`,
				method: "GET",
				body: undefined,
				etag: undefined,
			},
			{
				url: `/v1/evaluations/quality-check/versions/1?project_id=${project_id}`,
				method: "GET",
				body: undefined,
				etag: undefined,
			},
		]);
	});
	it("keeps run list, evidence, and compare calls project-scoped", async () => {
		const left = "33333333-3333-4333-8333-333333333333";
		const right = "44444444-4444-4444-8444-444444444444";
		await listEvaluationRuns({
			project_id,
			status: "completed",
			evaluation_id: "55555555-5555-4555-8555-555555555555",
			limit: 10,
			offset: 20,
		});
		await getEvaluationRunEvidence({
			project_id,
			id: left,
			limit: 25,
			offset: 50,
		});
		await compareEvaluationRuns({ project_id, run_ids: [left, right] });
		expect(
			fetchMock.mock.calls.map(([url, init]) => ({
				url,
				method: init?.method ?? "GET",
				body: init?.body,
			})),
		).toEqual([
			{
				url: `/v1/evaluation-runs?project_id=${project_id}&status=completed&evaluation_id=55555555-5555-4555-8555-555555555555&limit=10&offset=20`,
				method: "GET",
				body: undefined,
			},
			{
				url: `/v1/evaluation-runs/${left}/evidence?project_id=${project_id}&limit=25&offset=50`,
				method: "GET",
				body: undefined,
			},
			{
				url: `/v1/evaluation-runs/compare?project_id=${project_id}`,
				method: "POST",
				body: JSON.stringify({ run_ids: [left, right] }),
			},
		]);
	});
});
