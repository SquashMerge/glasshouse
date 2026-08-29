import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createEvaluation,
	getEvaluation,
	getEvaluationDraft,
	getEvaluationVersion,
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
});
