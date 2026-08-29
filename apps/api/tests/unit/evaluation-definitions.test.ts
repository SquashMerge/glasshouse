import { describe, expect, it } from "bun:test";
import { definitionHash } from "../../src/db/evaluations";
import { EvaluationDefinitionInput } from "../../src/schemas/evaluations";

const definition = {
	dataset_version_id: "11111111-1111-4111-8111-111111111111",
	evaluator: {
		kind: "exact_match" as const,
		expected_output_path: "$.expected_output",
		output_path: "$.output",
	},
	target: {
		kind: "configured_llm" as const,
		model: "model",
		system_prompt: "secret prompt",
	},
	execution_defaults: { temperature: 0, max_tokens: null },
	thresholds: { minimum_pass_rate: 0.9 },
};

describe("Evaluation definitions", () => {
	it("has a stable canonical hash independent of object key order", () => {
		expect(definitionHash(definition)).toBe(
			definitionHash({
				...definition,
				evaluator: {
					output_path: "$.output",
					kind: "exact_match",
					expected_output_path: "$.expected_output",
				},
			}),
		);
	});
	it("rejects executable and untyped evaluator configuration", () => {
		expect(
			EvaluationDefinitionInput.safeParse({
				...definition,
				evaluator: { ...definition.evaluator, code: "return true" },
			}).success,
		).toBe(false);
		expect(
			EvaluationDefinitionInput.safeParse({
				...definition,
				target: { kind: "arbitrary_url" },
			}).success,
		).toBe(false);
	});
	it("keeps target content out of audit payload contracts", () => {
		expect(Object.keys(definition)).toContain("target");
		expect([
			"project_id",
			"evaluation_id",
			"actor_id",
			"event_type",
			"definition_version_id",
			"content_hash",
		]).not.toContain("target");
	});
});
