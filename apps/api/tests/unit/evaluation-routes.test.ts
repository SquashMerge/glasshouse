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
import { EvaluationDefinitionVersion } from "../../src/schemas/evaluations";

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
});
