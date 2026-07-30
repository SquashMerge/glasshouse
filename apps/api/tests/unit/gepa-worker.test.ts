import { afterEach, describe, expect, it } from "bun:test";
import {
	MAX_OPTIMIZATION_CANDIDATE_BYTES,
	readWorkerOutput,
	runGepaWorker,
} from "../../src/lib/gepa-worker";

describe("GEPA worker adapter", () => {
	const prior = process.env.GEPA_WORKER_MODE;
	const priorModels = process.env.GEPA_ALLOWED_MODELS;
	afterEach(() => {
		process.env.GEPA_WORKER_MODE = prior;
		process.env.GEPA_ALLOWED_MODELS = priorModels;
	});

	it("uses the deterministic credential-free worker mode", async () => {
		process.env.GEPA_WORKER_MODE = "fake";
		process.env.GEPA_ALLOWED_MODELS = "openai/gpt-4.1-mini";
		const result = await runGepaWorker(
			{
				target: "system",
				source: "Hello {{name}}",
				evaluator: { type: "default_adapter" },
				dataset: {
					version: 1,
					rubric: "Greet the caller clearly.",
					training_examples: [{ input: "Hello", answer: "Hello" }],
					validation_examples: [
						{ input: "Welcome Ada", answer: "Welcome Ada" },
					],
				},
				model_config: {
					task_lm: "openai/gpt-4.1-mini",
					reflection_lm: "openai/gpt-4.1-mini",
				},
				budget: { max_metric_calls: 2 },
			},
			new AbortController().signal,
		);
		expect(result.candidate).toContain("Hello {{name}}");
		expect(result.metric_calls_used).toBe(0);
		expect(result).toMatchObject({
			training_score: 1,
			validation_score: 1,
			baseline_validation_score: 0,
		});
	});

	it("rejects oversized worker output before buffering it", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						"x".repeat(MAX_OPTIMIZATION_CANDIDATE_BYTES + 1025),
					),
				);
				controller.close();
			},
		});
		await expect(readWorkerOutput(stream)).rejects.toThrow("size limit");
	});
});
