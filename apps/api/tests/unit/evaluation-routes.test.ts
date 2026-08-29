import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
	createEvaluationRoute,
	getEvaluationDraftRoute,
	getEvaluationRoute,
	getEvaluationVersionRoute,
	handleCreateEvaluation,
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

describe("evaluation route contract", () => {
	it("documents query-scoped create and slug-scoped draft and version paths", () => {
		const app = new OpenAPIHono();
		app.openapi(createEvaluationRoute, handleCreateEvaluation);
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
	});
});
