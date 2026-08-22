import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
	loadRedactionOptions,
	redactAttributesJson,
	redactDatasetCapture,
	redactMetadata,
	redactTraceText,
} from "../../src/db/redact";

describe("redactTraceText", () => {
	it("returns text unchanged when redaction is off", () => {
		const out = redactTraceText("hello world", {
			redactInput: false,
			redactKeys: [],
		});
		expect(out).toBe("hello world");
	});

	it("replaces with [REDACTED] when redaction is on", () => {
		const out = redactTraceText("hello world", {
			redactInput: true,
			redactKeys: [],
		});
		expect(out).toBe("[REDACTED]");
	});

	it("handles null and undefined", () => {
		expect(redactTraceText(null, { redactInput: true, redactKeys: [] })).toBe(
			"",
		);
		expect(
			redactTraceText(undefined, { redactInput: false, redactKeys: [] }),
		).toBe("");
	});
});

describe("redactAttributesJson", () => {
	it("keeps non-redacted envelope attributes and omits null provenance from storage", () => {
		const json = JSON.stringify({
			schema_version: 1,
			attributes: [{ key: "user.email", value: { stringValue: "a@b.c" } }],
		});
		expect(
			JSON.parse(
				redactAttributesJson(json, { redactInput: false, redactKeys: [] }),
			),
		).toEqual({
			schema_version: 1,
			attributes: [{ key: "user.email", value: { stringValue: "a@b.c" } }],
		});
	});

	it("replaces values of redacted envelope attributes with [REDACTED]", () => {
		const json = JSON.stringify({
			schema_version: 1,
			attributes: [
				{ key: "user.email", value: { stringValue: "a@b.c" } },
				{ key: "gen_ai.system", value: { stringValue: "openai" } },
			],
		});
		const out = JSON.parse(
			redactAttributesJson(json, {
				redactInput: false,
				redactKeys: ["user.email"],
			}),
		);
		expect(out.attributes[0].value.stringValue).toBe("[REDACTED]");
		expect(out.attributes[1]).toEqual({
			key: "gen_ai.system",
			value: { stringValue: "openai" },
		});
	});

	it("strips all prompt namespace attributes before envelope redaction", () => {
		const out = redactMetadata(
			{
				schema_version: 1,
				attributes: [
					{ key: "astraea.prompt.template", value: { stringValue: "secret" } },
					{
						key: "astraea.prompt.unknown",
						value: { stringValue: "also secret" },
					},
					{ key: "user.email", value: { stringValue: "a@b.c" } },
				],
				prompt_provenance: null,
			},
			{ redactInput: false, redactKeys: ["user.email"] },
		);
		expect(out).toEqual({
			schema_version: 1,
			attributes: [{ key: "user.email", value: { stringValue: "[REDACTED]" } }],
			prompt_provenance: null,
		});
	});

	it("returns malformed JSON unchanged", () => {
		const out = redactAttributesJson("not json", {
			redactInput: false,
			redactKeys: ["x"],
		});
		expect(out).toBe("not json");
	});
});

describe("redactDatasetCapture", () => {
	it("redacts source text and configured keys recursively before draft persistence", () => {
		expect(
			redactDatasetCapture(
				{
					prompt: "protected source text",
					metadata: { "user.email": "person@example.test", safe: 1 },
				},
				{ redactInput: true, redactKeys: ["user.email"] },
			),
		).toEqual({
			value: {
				prompt: "[REDACTED]",
				metadata: { "user.email": "[REDACTED]", safe: 1 },
			},
			redacted: true,
		});
	});
});

describe("loadRedactionOptions", () => {
	const ORIG_INPUT = process.env.ASTRAEA_REDACT_INPUT;
	const ORIG_KEYS = process.env.ASTRAEA_REDACT_KEYS;

	beforeEach(() => {
		delete process.env.ASTRAEA_REDACT_INPUT;
		delete process.env.ASTRAEA_REDACT_KEYS;
	});
	afterEach(() => {
		if (ORIG_INPUT === undefined) delete process.env.ASTRAEA_REDACT_INPUT;
		else process.env.ASTRAEA_REDACT_INPUT = ORIG_INPUT;
		if (ORIG_KEYS === undefined) delete process.env.ASTRAEA_REDACT_KEYS;
		else process.env.ASTRAEA_REDACT_KEYS = ORIG_KEYS;
	});

	it("defaults to redactInput=false and empty redactKeys", () => {
		expect(loadRedactionOptions()).toEqual({
			redactInput: false,
			redactKeys: [],
		});
	});

	it("parses ASTRAEA_REDACT_INPUT=true", () => {
		process.env.ASTRAEA_REDACT_INPUT = "true";
		expect(loadRedactionOptions().redactInput).toBe(true);
	});

	it("parses ASTRAEA_REDACT_INPUT=TRUE (case-insensitive)", () => {
		process.env.ASTRAEA_REDACT_INPUT = "TRUE";
		expect(loadRedactionOptions().redactInput).toBe(true);
	});

	it("parses comma-separated ASTRAEA_REDACT_KEYS", () => {
		process.env.ASTRAEA_REDACT_KEYS = "user.email, user.ip , http.url";
		expect(loadRedactionOptions().redactKeys).toEqual([
			"user.email",
			"user.ip",
			"http.url",
		]);
	});
});
