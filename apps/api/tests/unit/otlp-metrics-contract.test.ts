import { expect, test } from "bun:test";
import { validatePolicy } from "../../src/db/governance.js";
import { openapiApp } from "../../src/openapi.js";

test("metrics is a governed retention class with the existing day bounds", () => {
	const input = {
		retention: { traces: 30, metrics: 7 },
		redaction: { mode: "none" as const, keys: [] },
	};
	expect(validatePolicy(input)).toEqual(input);
	for (const days of [0, -1, 1.5, 3651]) {
		const invalid = {
			...input,
			retention: { ...input.retention, metrics: days },
		};
		expect(() => validatePolicy(invalid)).toThrow();
	}
});

test("metrics documents SDK ingestion separately from authorized product reads", () => {
	const document = openapiApp.getOpenAPI31Document({
		openapi: "3.1.0",
		info: { title: "Metrics contract", version: "test" },
	});
	const path = document.paths?.["/v1/metrics"];
	expect(path?.post).toBeDefined();
	expect(path?.get).toBeDefined();
	expect(path?.post?.security).toContainEqual({ bearerAuth: [] });
	expect(path?.get?.security).not.toContainEqual({ bearerAuth: [] });
	const body = path?.post?.requestBody;
	expect(body && "content" in body ? Object.keys(body.content) : []).toEqual(
		expect.arrayContaining(["application/json", "application/x-protobuf"]),
	);
});
