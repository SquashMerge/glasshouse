import { describe, expect, it } from "bun:test";
import {
	DEFAULT_GOVERNANCE_POLICY,
	policyHash,
	validatePolicy,
} from "../../src/db/governance";
import {
	policyRedactionOptions,
	redactMetadata,
	redactTraceText,
} from "../../src/db/redact";

describe("governance policy validation", () => {
	it("defines the automatically approved baseline without enabling redaction", () => {
		expect(DEFAULT_GOVERNANCE_POLICY).toEqual({
			retention: { traces: 30, datasets: 90, feedback: 90 },
			redaction: { mode: "none", keys: [] },
		});
		expect(validatePolicy(DEFAULT_GOVERNANCE_POLICY)).toEqual(
			DEFAULT_GOVERNANCE_POLICY,
		);
		const input = process.env.GLASSHOUSE_REDACT_INPUT;
		const keys = process.env.GLASSHOUSE_REDACT_KEYS;
		process.env.GLASSHOUSE_REDACT_INPUT = "false";
		process.env.GLASSHOUSE_REDACT_KEYS = "";
		try {
			expect(
				policyRedactionOptions(DEFAULT_GOVERNANCE_POLICY.redaction),
			).toEqual({
				redactInput: false,
				redactKeys: [],
			});
		} finally {
			if (input === undefined) delete process.env.GLASSHOUSE_REDACT_INPUT;
			else process.env.GLASSHOUSE_REDACT_INPUT = input;
			if (keys === undefined) delete process.env.GLASSHOUSE_REDACT_KEYS;
			else process.env.GLASSHOUSE_REDACT_KEYS = keys;
		}
	});

	it("canonicalizes equivalent policy content for idempotency", () => {
		const first = validatePolicy({
			retention: { traces: 30, datasets: 90 },
			redaction: {
				mode: "all_text",
				keys: ["user.email", "http.url", "user.email"],
			},
		});
		const second = validatePolicy({
			retention: { datasets: 90, traces: 30 },
			redaction: { mode: "all_text", keys: ["http.url", "user.email"] },
		});
		expect(first.redaction.keys).toEqual(["http.url", "user.email"]);
		expect(policyHash(first)).toBe(policyHash(second));
	});

	it("rejects unbounded days and arbitrary key patterns", () => {
		expect(() =>
			validatePolicy({
				retention: { traces: 0 },
				redaction: { mode: "none", keys: [] },
			}),
		).toThrow();
		expect(() =>
			validatePolicy({
				retention: {},
				redaction: { mode: "none", keys: [".*"] },
			}),
		).toThrow();
	});
});

describe("approved policy redaction", () => {
	it("preserves operator redaction as a non-relaxable baseline", () => {
		const input = process.env.GLASSHOUSE_REDACT_INPUT;
		const keys = process.env.GLASSHOUSE_REDACT_KEYS;
		process.env.GLASSHOUSE_REDACT_INPUT = "true";
		process.env.GLASSHOUSE_REDACT_KEYS = "operator.secret, user.email";
		try {
			expect(policyRedactionOptions({ mode: "none", keys: [] })).toEqual({
				redactInput: true,
				redactKeys: ["operator.secret", "user.email"],
			});
			expect(
				policyRedactionOptions({ mode: "all_text", keys: ["policy.secret"] }),
			).toEqual({
				redactInput: true,
				redactKeys: ["operator.secret", "user.email", "policy.secret"],
			});
		} finally {
			if (input === undefined) delete process.env.GLASSHOUSE_REDACT_INPUT;
			else process.env.GLASSHOUSE_REDACT_INPUT = input;
			if (keys === undefined) delete process.env.GLASSHOUSE_REDACT_KEYS;
			else process.env.GLASSHOUSE_REDACT_KEYS = keys;
		}
	});

	it("redacts text and configured metadata before an ingress consumer uses it", () => {
		const options = policyRedactionOptions({
			mode: "all_text",
			keys: ["user.email"],
		});
		expect(redactTraceText("raw secret", options)).toBe("[REDACTED]");
		expect(
			redactMetadata(
				{
					schema_version: 1,
					attributes: [
						{ key: "user.email", value: { stringValue: "raw@example.test" } },
					],
					prompt_provenance: null,
				},
				options,
			).attributes[0]?.value,
		).toEqual({ stringValue: "[REDACTED]" });
	});

	it("removes normalized text aliases from metadata in all-text mode", () => {
		const metadata = redactMetadata(
			{
				schema_version: 1,
				attributes: [
					{ key: "gen_ai.prompt.0.content", value: { stringValue: "secret" } },
					{
						key: "gen_ai.completion.0.content",
						value: { stringValue: "secret" },
					},
					{ key: "input.value", value: { stringValue: "secret" } },
					{ key: "output.value", value: { stringValue: "secret" } },
					{ key: "safe", value: { stringValue: "kept" } },
				],
				prompt_provenance: null,
			},
			policyRedactionOptions({ mode: "all_text", keys: [] }),
		);
		expect(metadata.attributes).toEqual([
			{ key: "safe", value: { stringValue: "kept" } },
		]);
	});
});
