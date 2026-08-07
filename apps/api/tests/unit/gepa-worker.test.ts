import { afterEach, describe, expect, it } from "bun:test";
import {
	MAX_OPTIMIZATION_CANDIDATE_BYTES,
	parseWorkerResult,
	readWorkerDiagnostics,
	readWorkerOutput,
	runGepaWorker,
} from "../../src/lib/gepa-worker";
import { logger } from "../../src/lib/logger";

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

	it("keeps GEPA's actual metric-call total when a batch crosses its soft stop threshold", () => {
		expect(
			parseWorkerResult(
				JSON.stringify({
					candidate: "candidate",
					training_score: 1,
					validation_score: 1,
					baseline_validation_score: 0,
					metric_calls_used: 7,
				}),
				5,
			),
		).toEqual({
			candidate: "candidate",
			training_score: 1,
			validation_score: 1,
			baseline_validation_score: 0,
			metric_calls_used: 7,
		});
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

	it("propagates a live telemetry persistence failure", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'ASTRAEA_GEPA_PROGRESS {"metric_calls_used":3}\n',
					),
				);
				controller.close();
			},
		});
		await expect(
			readWorkerDiagnostics(stream, () => {
				throw new Error("telemetry persistence failed");
			}),
		).rejects.toThrow("telemetry persistence failed");
	});

	it("logs only bounded worker diagnostic metadata on failure", async () => {
		process.env.GEPA_WORKER_MODE = "fake";
		process.env.GEPA_ALLOWED_MODELS = "openai/gpt-4.1-mini";
		const originalLogger = logger.error;
		const errors: Array<{ event: string; cause: unknown; fields: unknown }> =
			[];
		logger.error = (event, cause, fields = {}) =>
			errors.push({ event, cause, fields });
		try {
			await expect(
				runGepaWorker(
					{
						target: "system",
						source: "Hello",
						evaluator: { type: "unsupported" },
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
				),
			).rejects.toThrow("GEPA worker failed");
			expect(errors).toEqual([
				{
					event: "optimization.worker_failed",
					cause: expect.objectContaining({ message: "GEPA worker failed" }),
					fields: {
						exit_code: 2,
						diagnostic_bytes: 37,
					},
				},
			]);
		} finally {
			logger.error = originalLogger;
		}
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
