import { describe, expect, it } from "bun:test";
import {
	MAX_GEPA_METRIC_CALLS,
	MIN_GEPA_METRIC_CALLS,
	validateGepaConfiguration,
} from "../../src/lib/gepa-config";

describe("GEPA configuration", () => {
	it("rejects a budget below the minimum needed to evaluate a candidate", () => {
		const prior = process.env.GEPA_ALLOWED_MODELS;
		process.env.GEPA_ALLOWED_MODELS = "openai/gpt-4.1-mini";
		try {
			expect(() =>
				validateGepaConfiguration({
					model_config: {
						task_lm: "openai/gpt-4.1-mini",
						reflection_lm: "openai/gpt-4.1-mini",
					},
					budget: { max_metric_calls: MIN_GEPA_METRIC_CALLS - 1 },
				}),
			).toThrow("must be at least");
		} finally {
			process.env.GEPA_ALLOWED_MODELS = prior;
		}
	});

	it("rejects a budget above the hard spend ceiling", () => {
		const prior = process.env.GEPA_ALLOWED_MODELS;
		process.env.GEPA_ALLOWED_MODELS = "openai/gpt-4.1-mini";
		try {
			expect(() =>
				validateGepaConfiguration({
					model_config: {
						task_lm: "openai/gpt-4.1-mini",
						reflection_lm: "openai/gpt-4.1-mini",
					},
					budget: { max_metric_calls: MAX_GEPA_METRIC_CALLS + 1 },
				}),
			).toThrow("must not exceed");
		} finally {
			process.env.GEPA_ALLOWED_MODELS = prior;
		}
	});

	it("rejects models outside the configured allowlist", () => {
		const prior = process.env.GEPA_ALLOWED_MODELS;
		process.env.GEPA_ALLOWED_MODELS = "openai/gpt-4.1-mini";
		try {
			expect(() =>
				validateGepaConfiguration({
					model_config: {
						task_lm: "openai/gpt-4.1-mini",
						reflection_lm: "openai/gpt-4.1",
					},
					budget: { max_metric_calls: 2 },
				}),
			).toThrow("unconfigured model");
		} finally {
			process.env.GEPA_ALLOWED_MODELS = prior;
		}
	});
});
