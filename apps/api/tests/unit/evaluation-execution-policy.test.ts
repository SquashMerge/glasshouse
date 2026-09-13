import { describe, expect, it } from "bun:test";
import {
	EvaluationExecutionPolicyError,
	resolveEvaluationExecutionPolicy,
} from "../../src/lib/evaluation-execution-policy";

describe("Evaluation execution policy", () => {
	it("rejects an unapproved provider/model before a runnable run is admitted", () => {
		expect(() =>
			resolveEvaluationExecutionPolicy(
				{ provider: "openai", model: "gpt-expensive" },
				2,
				{
					EVALUATION_ALLOWED_MODELS: "openai/gpt-4o-mini",
					EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT: "4",
					EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR: "2",
					EVALUATION_MAX_CASES_PER_RUN: "100",
					EVALUATION_MAX_PROVIDER_CALLS_PER_RUN: "100",
				},
			),
		).toThrow(EvaluationExecutionPolicyError);
	});
});
