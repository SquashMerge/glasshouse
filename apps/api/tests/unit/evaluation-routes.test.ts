import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
	createEvaluationRoute,
	archiveEvaluationRoute,
	restoreEvaluationRoute,
	tombstoneEvaluationRoute,
	getEvaluationDraftRoute,
	getEvaluationRoute,
	getEvaluationVersionRoute,
	handleCreateEvaluation,
	handleArchiveEvaluation,
	handleRestoreEvaluation,
	handleTombstoneEvaluation,
	handleGetEvaluation,
	handleGetEvaluationDraft,
	handleGetEvaluationVersion,
	handleListEvaluationVersions,
	handlePublishEvaluationDraft,
	handlePutEvaluationDraft,
	listEvaluationVersionsRoute,
	publishEvaluationDraftRoute,
	putEvaluationDraftRoute,
} from "../../src/routes/evaluations";
import {
	EvaluationDefinitionInput,
	EvaluationDefinitionVersion,
	EvaluationDraft,
} from "../../src/schemas/evaluations";

describe("evaluation route contract", () => {
	it("documents query-scoped create and slug-scoped draft and version paths", () => {
		const app = new OpenAPIHono();
		app.openapi(createEvaluationRoute, handleCreateEvaluation);
		app.openapi(archiveEvaluationRoute, handleArchiveEvaluation);
		app.openapi(restoreEvaluationRoute, handleRestoreEvaluation);
		app.openapi(tombstoneEvaluationRoute, handleTombstoneEvaluation);
		app.openapi(getEvaluationRoute, handleGetEvaluation);
		app.openapi(getEvaluationDraftRoute, handleGetEvaluationDraft);
		app.openapi(putEvaluationDraftRoute, handlePutEvaluationDraft);
		app.openapi(publishEvaluationDraftRoute, handlePublishEvaluationDraft);
		app.openapi(listEvaluationVersionsRoute, handleListEvaluationVersions);
		app.openapi(getEvaluationVersionRoute, handleGetEvaluationVersion);
		const document = app.getOpenAPIDocument({
			openapi: "3.0.0",
			info: { title: "test", version: "1" },
		});
		expect(
			document.paths?.["/v1/evaluations"]?.post?.parameters,
		).toContainEqual(
			expect.objectContaining({
				name: "project_id",
				in: "query",
				required: true,
			}),
		);
		expect(document.paths?.["/v1/evaluations/{slug}/draft"]?.put).toBeDefined();
		expect(
			document.paths?.["/v1/evaluations/{slug}/versions/{version}"]?.get,
		).toBeDefined();
		expect(document.paths?.["/v1/evaluations/{id}/draft"]).toBeUndefined();
		expect(document.paths?.["/v1/evaluations/{slug}"]?.delete).toBeDefined();
		expect(
			document.paths?.["/v1/evaluations/{slug}/tombstone"]?.delete,
		).toBeDefined();
	});
	it("documents legacy immutable snapshots without fabricating the typed contract", () => {
		expect(
			EvaluationDefinitionVersion.safeParse({
				id: "11111111-1111-4111-8111-111111111111",
				evaluation_id: "22222222-2222-4222-8222-222222222222",
				project_id: "33333333-3333-4333-8333-333333333333",
				version: 1,
				dataset_version_id: "44444444-4444-4444-8444-444444444444",
				definition_contract: "legacy_untyped",
				sampling: null,
				evaluator: { kind: "exact_match" },
				target: { kind: "configured_llm" },
				execution_defaults: {},
				limits: null,
				thresholds: {},
				content_hash: "b".repeat(64),
				published_draft_revision: 1,
				created_at: "2026-01-01T00:00:00.000Z",
			}).success,
		).toBe(true);
	});
	it("documents upgraded incomplete drafts separately from the typed replacement contract", () => {
		const upgradedLegacyDraft = {
			dataset_version_id: "44444444-4444-4444-8444-444444444444",
			sampling: { strategy: "first_n", sample_size: 100, seed: 0 },
			evaluator: { kind: "exact_match", version: "v1" },
			target: { kind: "configured_llm" },
			execution_defaults: {},
			limits: { max_cost_usd: 10, max_duration_seconds: 3600 },
			thresholds: {},
		};
		expect(
			EvaluationDraft.safeParse({
				...upgradedLegacyDraft,
				evaluation_id: "11111111-1111-4111-8111-111111111111",
				project_id: "22222222-2222-4222-8222-222222222222",
				revision: 1,
				updated_at: "2026-01-01T00:00:00.000Z",
				definition_contract: "legacy_incomplete",
			}).success,
		).toBe(true);
		expect(
			EvaluationDefinitionInput.safeParse(upgradedLegacyDraft).success,
		).toBe(true);
		expect(
			EvaluationDefinitionInput.safeParse({
				...upgradedLegacyDraft,
				evaluator: {
					...upgradedLegacyDraft.evaluator,
					expected_output_path: "$.expected_output",
					output_path: "$.output",
				},
				target: {
					...upgradedLegacyDraft.target,
					model: null,
					system_prompt: null,
				},
				execution_defaults: { temperature: 0, max_tokens: null },
				thresholds: { minimum_pass_rate: null },
			}).success,
		).toBe(true);
	});
});
