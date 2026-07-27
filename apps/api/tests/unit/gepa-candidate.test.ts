import { describe, expect, it } from "bun:test";
import { validateGepaCandidate } from "../../src/routes/prompt-optimizations";

describe("GEPA candidate validation", () => {
	it("rejects a malformed candidate even when its Mustache tokens match", () => {
		expect(() =>
			validateGepaCandidate("Hello {{name}}", "Hello {{name"),
		).toThrow("malformed");
	});

	it("accepts exactly 4096 characters and rejects 4097", () => {
		expect(() => validateGepaCandidate("x", "x".repeat(4096))).not.toThrow();
		expect(() => validateGepaCandidate("x", "x".repeat(4097))).toThrow(
			"4096 characters",
		);
	});

	it("accepts exactly 128 lines and rejects 129", () => {
		const lines = Array.from({ length: 128 }, () => "x").join("\n");
		expect(() => validateGepaCandidate("x", lines)).not.toThrow();
		expect(() => validateGepaCandidate("x", `${lines}\nx`)).toThrow(
			"128 lines",
		);
	});
});
