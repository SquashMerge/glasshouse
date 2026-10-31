import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { openapiApp } from "../../src/openapi.js";

const feedback = {
	id: "00000000-0000-4000-8000-000000000001",
	project_id: "00000000-0000-4000-8000-000000000002",
	trace_id: "a".repeat(32),
	observation_id: null,
	target_type: "trace",
	value: 1,
	sentiment: "positive",
	reason: null,
	comment: null,
	status: "reviewed",
	note: null,
	dataset_id: null,
	dataset_item_id: null,
	dataset_draft_item_id: null,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

test("OpenAPI 3.1 current feedback response accepts null and valid feedback but rejects invalid objects", async () => {
	const document = openapiApp.getOpenAPI31Document({
		openapi: "3.1.0",
		info: { title: "test", version: "1" },
	});
	const liveDocument = await (await openapiApp.request("/openapi.json")).json();
	for (const doc of [document, liveDocument]) {
		const response = doc.paths?.["/v1/feedback/mine"]?.get?.responses?.["200"];
		if (!response || !("content" in response))
			throw new Error("Missing response schema");
		const schema = response.content?.["application/json"]?.schema;
		if (!schema) throw new Error("Missing response schema");
		const validate = new Ajv2020({
			strict: false,
			validateFormats: false,
		}).compile({
			...schema,
			components: doc.components,
		});
		expect(validate(feedback)).toBe(true);
		expect(validate({ ...feedback, value: 42 })).toBe(false);
		expect(validate(null)).toBe(true);
	}
});
