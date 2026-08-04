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

	it("requires preview authorization for retention runs", () => {
		const app = new OpenAPIHono();
		app.openapi(runRetention, handleRunRetention);
		const document = app.getOpenAPIDocument({
			openapi: "3.1.0",
			info: { title: "test", version: "1" },
		});
		const schema = (
			document.paths?.["/v1/governance/retention/runs"]?.post?.requestBody as {
				content: { "application/json": { schema: { required: string[] } } };
			}
		).content["application/json"].schema;
		expect(schema.required).toContain("preview_id");
		expect(
			document.paths?.["/v1/governance/retention/runs"]?.post?.requestBody
				?.required,
		).toBe(true);
	});

	it("requires governance JSON bodies and operation-specific success fields", () => {
		const app = new OpenAPIHono();
		app.openapi(createPolicyDraft, handleCreatePolicyDraft);
		app.openapi(previewRetention, handlePreviewRetention);
		app.openapi(runRetention, handleRunRetention);
		const document = app.getOpenAPIDocument({
			openapi: "3.1.0",
			info: { title: "test", version: "1" },
		});
		for (const path of [
			"/v1/governance/policy/drafts",
			"/v1/governance/retention/preview",
			"/v1/governance/retention/runs",
		] as const)
			expect(document.paths?.[path]?.post?.requestBody?.required).toBe(true);
		const preview = document.paths?.["/v1/governance/retention/preview"]?.post
			?.responses?.["200"] as any;
		expect(preview.content["application/json"].schema.required).toEqual(
			expect.arrayContaining([
				"policy_version_id",
				"counts",
				"preview_id",
				"preview_expires_at",
			]),
		);
		const run = document.paths?.["/v1/governance/retention/runs"]?.post
			?.responses?.["200"] as any;
		expect(run.content["application/json"].schema.required).toEqual(
			expect.arrayContaining([
				"policy_version_id",
				"counts",
				"run_id",
				"status",
			]),
		);
	});
});
