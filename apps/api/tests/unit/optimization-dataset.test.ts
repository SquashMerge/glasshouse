import { describe, expect, it } from "bun:test";
import {
	automaticPromotionReason,
	hasOverlappingOptimizationInputs,
	hashOptimizationDataset,
} from "../../src/lib/optimization-dataset";

const dataset = {
	version: 1 as const,
	rubric: "Prioritize deadlines and preserve task details.",
	training_examples: [{ input: "Plan the workday", answer: "Training label" }],
	validation_examples: [
		{ input: "Plan a different workday", answer: "Held-out label one" },
		{ input: "Plan tomorrow", answer: "Held-out label two" },
	],
};

describe("optimization dataset policy", () => {
	it("pins a deterministic hash for the full split and rubric", () => {
		const reordered = {
			...dataset,
			training_examples: dataset.training_examples.map((example) => ({
				answer: example.answer,
				input: example.input,
			})),
		};
		expect(hashOptimizationDataset(reordered)).toBe(
			hashOptimizationDataset(dataset),
		);
		expect(
			hashOptimizationDataset({ ...dataset, rubric: "Different rubric" }),
		).not.toBe(hashOptimizationDataset(dataset));
	});

	it("rejects normalized overlap or duplicate held-out inputs", () => {
		expect(
			hasOverlappingOptimizationInputs({
				...dataset,
				validation_examples: [
					{ input: " plan   THE workday ", answer: "Different label" },
				],
			}),
		).toBe(true);
		expect(
			hasOverlappingOptimizationInputs({
				...dataset,
				validation_examples: [
					{ input: "Independent day", answer: "One" },
					{ input: " independent   DAY ", answer: "Two" },
				],
			}),
		).toBe(true);
		expect(
			hasOverlappingOptimizationInputs({
				...dataset,
				validation_examples: [
					{ input: "Plan the wo\u200brkday", answer: "Different label" },
				],
			}),
		).toBe(true);
		expect(
			hasOverlappingOptimizationInputs({
				...dataset,
				validation_examples: [
					{ input: "Plan the wo\u115frkday", answer: "Different label" },
				],
			}),
		).toBe(true);
		expect(
			hasOverlappingOptimizationInputs({
				...dataset,
				training_examples: [
					{ input: "Please summarize today tasks", answer: "Training label" },
				],
				validation_examples: [
					{
						input: "Please summarize today tasks with dates",
						answer: "Held-out label",
					},
				],
			}),
		).toBe(true);
		expect(
			hasOverlappingOptimizationInputs({
				...dataset,
				training_examples: [
					{ input: "order a salad with fries", answer: "Training label" },
				],
				validation_examples: [
					{ input: "fries with a salad order", answer: "Held-out label" },
				],
			}),
		).toBe(true);
		expect(
			hasOverlappingOptimizationInputs({
				...dataset,
				training_examples: [
					{ input: "customer renewal proposal", answer: "Training label" },
				],
				validation_examples: [
					{ input: "custоmer renewal proposal", answer: "Held-out label" },
				],
			}),
		).toBe(true);
		expect(
			hasOverlappingOptimizationInputs({
				...dataset,
				training_examples: [{ input: "refund", answer: "Training label" }],
				validation_examples: [
					{ input: "refund now", answer: "Held-out label" },
				],
			}),
		).toBe(true);
	});

	it("rejects near-duplicate inputs below the former overlap threshold", () => {
		const trainingInput = Array.from(
			{ length: 100 },
			(_, index) => `training${index}`,
		).join(" ");
		const validationInput = [
			...Array.from({ length: 79 }, (_, index) => `training${index}`),
			...Array.from({ length: 21 }, (_, index) => `validation${index}`),
		].join(" ");

		expect(
			hasOverlappingOptimizationInputs({
				...dataset,
				training_examples: [{ input: trainingInput, answer: "Training label" }],
				validation_examples: [
					{ input: validationInput, answer: "Held-out label" },
				],
			}),
		).toBe(true);
	});

	it("requires independent held-out improvement for automatic promotion", () => {
		const evidence = {
			metric: "default_adapter.expected_answer_contains" as const,
			rubric: dataset.rubric,
			training: { sample_count: 1, score: 1 },
			validation: {
				sample_count: 2,
				score: 1,
				baseline_score: 0.5,
				held_out: true as const,
			},
			leakage: { status: "passed" as const, reason: null },
		};
		expect(automaticPromotionReason(evidence)).toBeNull();
		expect(
			automaticPromotionReason({
				...evidence,
				validation: { ...evidence.validation, sample_count: 1 },
			}),
		).toBe("insufficient_held_out_validation");
		expect(
			automaticPromotionReason({
				...evidence,
				validation: { ...evidence.validation, score: 0.5 },
			}),
		).toBe("held_out_score_did_not_improve");
	});
});
