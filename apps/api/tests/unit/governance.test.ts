import { describe, expect, it } from "bun:test";
import { policyHash, validatePolicy } from "../../src/db/governance";
import {
	policyRedactionOptions,
	redactMetadata,
	redactTraceText,
} from "../../src/db/redact";

describe("governance policy validation", () => {
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
});
