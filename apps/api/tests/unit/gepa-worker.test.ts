import { afterEach, describe, expect, it } from "bun:test";
import { runGepaWorker } from "../../src/lib/gepa-worker";

describe("GEPA worker adapter", () => {
	const prior = process.env.GEPA_WORKER_MODE;
	afterEach(() => {
		process.env.GEPA_WORKER_MODE = prior;
	});

	it("uses the deterministic credential-free worker mode", async () => {
		process.env.GEPA_WORKER_MODE = "fake";
		const result = await runGepaWorker(
			{
				target: "system",
				source: "Hello {{name}}",
				evaluator: { type: "default_adapter" },
				examples: [{ input: "Hello", answer: "Hello" }],
				model_config: {
					task_lm: "openai/gpt-4.1-mini",
					reflection_lm: "openai/gpt-4.1-mini",
				},
				budget: { max_metric_calls: 1 },
			},
			new AbortController().signal,
		);
		expect(result.candidate).toContain("Hello {{name}}");
	});
});
