import { describe, expect, it } from "bun:test";
import {
	approvePolicy,
	createPolicyDraft,
	getEffectivePolicy,
	handleApprovePolicy,
	handleCreatePolicyDraft,
	handleGetEffectivePolicy,
	handleListPolicyHistory,
	handleListRetentionRuns,
	handlePreviewRetention,
	handleRunRetention,
	listPolicyHistory,
	listRetentionRuns,
	previewRetention,
	runRetention,
} from "../../src/routes/governance";
import { OpenAPIHono } from "@hono/zod-openapi";

describe("governance OpenAPI contracts", () => {
	it("documents ErrorEnvelope 500 responses for every governance route", () => {
		const app = new OpenAPIHono();
		app.openapi(getEffectivePolicy, handleGetEffectivePolicy);
		app.openapi(listPolicyHistory, handleListPolicyHistory);
		app.openapi(createPolicyDraft, handleCreatePolicyDraft);
		app.openapi(approvePolicy, handleApprovePolicy);
		app.openapi(previewRetention, handlePreviewRetention);
		app.openapi(runRetention, handleRunRetention);
		app.openapi(listRetentionRuns, handleListRetentionRuns);
		const document = app.getOpenAPIDocument({
			openapi: "3.1.0",
			info: { title: "test", version: "1" },
		});
		for (const path of Object.values(document.paths ?? {})) {
			for (const operation of Object.values(path ?? {})) {
				if (typeof operation !== "object" || operation === null) continue;
				expect(
					(operation as { responses: Record<string, unknown> }).responses[
						"500"
					],
				).toBeDefined();
			}
		}
	});
});
