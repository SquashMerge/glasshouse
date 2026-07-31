import { afterEach, describe, expect, it } from "bun:test";
import {
	MAX_OPTIMIZATION_CANDIDATE_BYTES,
	parseWorkerResult,
	readWorkerDiagnostics,
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
				examples: [{ input: "Hello", answer: "Hello" }],
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
	});

	it("keeps GEPA's actual metric-call total when a batch crosses its soft stop threshold", () => {
		expect(
			parseWorkerResult(
				JSON.stringify({ candidate: "candidate", metric_calls_used: 7 }),
				5,
			),
		).toEqual({ candidate: "candidate", metric_calls_used: 7 });
	});

	it("reports structured metric progress without retaining it in diagnostics", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'Iteration 0 started\nASTRAEA_GEPA_PROGRESS {"metric_calls_used":3}\n',
					),
				);
				controller.close();
			},
		});
		const progress: number[] = [];
		await expect(
			readWorkerDiagnostics(stream, ({ metric_calls_used }) => {
				progress.push(metric_calls_used);
			}),
		).resolves.toBe("Iteration 0 started");
		expect(progress).toEqual([3]);
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
