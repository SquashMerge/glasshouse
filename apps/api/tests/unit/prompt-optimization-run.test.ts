import { describe, expect, it } from "bun:test";
import type { OptimizationJob } from "../../src/db/prompt-optimizations";
import {
	runOptimizationJob,
	type OptimizationDependencies,
} from "../../src/routes/prompt-optimizations";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const PROMPT = "33333333-3333-4333-8333-333333333333";

function job(validationExamples = 2): OptimizationJob {
	return {
		id: JOB,
		project_id: PROJECT,
		prompt_id: PROMPT,
		prompt_slug: "daily-summary",
		source_version: 3,
		target: "system",
		evaluator: { type: "default_adapter" },
		dataset: {
			version: 1,
			rubric:
				"Prioritize deadlines, preserve tasks, and keep summaries concise.",
			training_examples: [
				{
					input: "Training task list",
					answer: "Training answer label that stays out of the prompt.",
				},
			],
			validation_examples: Array.from(
				{ length: validationExamples },
				(_, index) => ({
					input: `Held-out task list ${index + 1}`,
					answer: `Held-out answer label ${index + 1} that stays out of the prompt.`,
				}),
			),
		},
		dataset_hash: "a".repeat(64),
		model_config: { task_lm: "task", reflection_lm: "reflection" },
		budget: { max_metric_calls: 5 },
		status: "queued",
		requested_by: "admin",
		result_version: null,
		candidate_content: null,
		evidence: null,
		promotion_status: "pending",
		promotion_reason: null,
		reviewed_by: null,
		promoted_at: null,
		error_message: null,
		metric_calls_used: null,
		created_at: "2026-07-15T10:00:00.000Z",
		updated_at: "2026-07-15T10:00:00.000Z",
		completed_at: null,
	};
}

function dependencies(input: {
	result: {
		candidate: string;
		training_score: number | null;
		validation_score: number;
		baseline_validation_score: number;
		metric_calls_used: number | null;
	};
	admitted?: boolean;
}) {
	const completed: Array<Record<string, unknown>> = [];
	const published: Array<Record<string, unknown>> = [];
	const metricCalls: Array<Record<string, unknown>> = [];
	const workerCalls: Array<Record<string, unknown>> = [];
	const d = {
		pool: () => ({}),
		worker: async (workerInput: Record<string, unknown>) => {
			workerCalls.push(workerInput);
			return input.result;
		},
		create: async () => job(),
		get: async () => job(),
		getActive: async () => null,
		claim: async () => true,
		admitExecution: async (
			_pool: unknown,
			_input: Record<string, unknown>,
			invoke: () => Promise<unknown>,
		) =>
			input.admitted === false
				? { admitted: false as const }
				: { admitted: true as const, value: await invoke() },
		renew: async () => true,
		sourceMessages: async () => [
			{ role: "system" as const, content: "Summarize {{tasks}}" },
		],
		events: async () => [],
		stop: async () => job(),
		transition: async () => job(),
		complete: async (_pool: unknown, completion: Record<string, unknown>) => {
			completed.push(completion);
			return job();
		},
		publish: async (_pool: unknown, publication: Record<string, unknown>) => {
			published.push(publication);
			return 4;
		},
		recordMetricCalls: async (
			_pool: unknown,
			metricCallsInput: Record<string, unknown>,
		) => {
			metricCalls.push(metricCallsInput);
		},
		promote: async () => job(),
	} as unknown as OptimizationDependencies;
	return { d, completed, published, metricCalls, workerCalls };
}

describe("optimization completion policy", () => {
	it("does not invoke the provider when execution admission is revoked", async () => {
		const input = dependencies({
			admitted: false,
			result: {
				candidate: "Summarize {{tasks}} by urgency and timing.",
				training_score: 1,
				validation_score: 1,
				baseline_validation_score: 0,
				metric_calls_used: 3,
			},
		});
		await runOptimizationJob(job(), input.d);

		expect(input.workerCalls).toHaveLength(0);
		expect(input.completed).toHaveLength(0);
		expect(input.published).toHaveLength(0);
	});

	it("keeps a one-sample held-out result as a review-required draft", async () => {
		const input = dependencies({
			result: {
				candidate: "Summarize {{tasks}} by urgency and timing.",
				training_score: 1,
				validation_score: 1,
				baseline_validation_score: 0,
				metric_calls_used: 3,
			},
		});
		const oneValidationJob = job(1);
		await runOptimizationJob(oneValidationJob, input.d);

		expect(input.published).toHaveLength(0);
		expect(input.metricCalls).toEqual([
			{ id: JOB, worker_id: expect.any(String), metric_calls_used: 3 },
		]);
		expect(input.completed).toHaveLength(1);
		expect(input.completed[0]).toMatchObject({
			candidate_content: "Summarize {{tasks}} by urgency and timing.",
			promotion_status: "review_required",
			promotion_reason: "insufficient_held_out_validation",
			evidence: { validation: { sample_count: 1, score: 1 } },
		});
	});

	it("publishes only a safe candidate that improves on two held-out examples", async () => {
		const input = dependencies({
			result: {
				candidate: "Summarize {{tasks}} by urgency and timing.",
				training_score: 1,
				validation_score: 0.75,
				baseline_validation_score: 0.5,
				metric_calls_used: 3,
			},
		});
		await runOptimizationJob(job(), input.d);

		expect(input.completed).toHaveLength(0);
		expect(input.published).toHaveLength(1);
		expect(input.published[0]).toMatchObject({
			evidence: {
				training: { sample_count: 1, score: 1 },
				validation: { sample_count: 2, score: 0.75, baseline_score: 0.5 },
			},
		});
	});

	it("retains held-out promotion evidence when the training score is unavailable", async () => {
		const input = dependencies({
			result: {
				candidate: "Summarize {{tasks}} by urgency and timing.",
				training_score: null,
				validation_score: 0.75,
				baseline_validation_score: 0.5,
				metric_calls_used: 5,
			},
		});
		await runOptimizationJob(job(), input.d);

		expect(input.published).toHaveLength(1);
		expect(input.published[0]).toMatchObject({
			evidence: {
				training: { sample_count: 1, score: null },
				validation: { sample_count: 2, score: 0.75, baseline_score: 0.5 },
			},
		});
	});

	it("blocks an expected-answer leak before it can reach publication", async () => {
		const leakingJob = job();
		const leakedAnswer = leakingJob.dataset.validation_examples[0]!.answer;
		const input = dependencies({
			result: {
				candidate: `Summarize {{tasks}}. Respond exactly: ${leakedAnswer.replace("Held-out", "Hel\u200bd-out")}`,
				training_score: 1,
				validation_score: 1,
				baseline_validation_score: 0,
				metric_calls_used: 3,
			},
		});
		await runOptimizationJob(leakingJob, input.d);

		expect(input.published).toHaveLength(0);
		expect(input.completed[0]).toMatchObject({
			candidate_content: null,
			promotion_status: "blocked",
			promotion_reason: "expected_answer_full_match",
			evidence: {
				leakage: { status: "failed", reason: "expected_answer_full_match" },
			},
		});
	});

	it("blocks an example-input leak before it can reach a draft", async () => {
		const leakingJob = job();
		const leakedInput =
			"The confidential memo requires immediate approval before Friday noon.";
		leakingJob.dataset.validation_examples[0]!.input = leakedInput;
		const input = dependencies({
			result: {
				candidate: `Summarize {{tasks}}. Include this example: ${leakedInput.replaceAll("m", "rn")}`,
				training_score: 1,
				validation_score: 1,
				baseline_validation_score: 0,
				metric_calls_used: 3,
			},
		});
		await runOptimizationJob(leakingJob, input.d);

		expect(input.published).toHaveLength(0);
		expect(input.completed[0]).toMatchObject({
			candidate_content: null,
			promotion_status: "blocked",
			promotion_reason: "candidate_validation_failed",
			evidence: { leakage: { status: "passed", reason: null } },
		});
	});
});
