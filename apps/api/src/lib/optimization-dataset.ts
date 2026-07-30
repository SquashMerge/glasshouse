import { createHash } from "node:crypto";
import { rectifyConfusion } from "unicode-confusables";
import type { JsonObject, JsonValue } from "../db/prompts.js";

export const OPTIMIZATION_DATASET_VERSION = 1;
export const MIN_AUTOMATIC_VALIDATION_EXAMPLES = 2;

export type OptimizationExample = {
	input: string;
	answer: string;
	additional_context?: JsonObject;
};

export type OptimizationDataset = {
	version: typeof OPTIMIZATION_DATASET_VERSION;
	rubric: string;
	training_examples: OptimizationExample[];
	validation_examples: OptimizationExample[];
};

export type LegacyOptimizationDataset = {
	version: 0;
	rubric: string;
	training_examples: OptimizationExample[];
	validation_examples: OptimizationExample[];
};

export type StoredOptimizationDataset =
	| OptimizationDataset
	| LegacyOptimizationDataset;

export type OptimizationLeakage = {
	status: "not_run" | "passed" | "failed";
	reason: "expected_answer_full_match" | "expected_answer_material_span" | null;
};

export type OptimizationEvidence = {
	metric: "default_adapter.expected_answer_contains";
	rubric: string;
	training: { sample_count: number; score: number | null };
	validation: {
		sample_count: number;
		score: number | null;
		baseline_score: number | null;
		held_out: true;
	};
	leakage: OptimizationLeakage;
};

export type OptimizationPromotionStatus =
	| "pending"
	| "auto_promoted"
	| "review_required"
	| "blocked"
	| "reviewed_promoted"
	| "legacy";

function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function canonicalDataset(dataset: OptimizationDataset): JsonObject {
	return {
		version: dataset.version,
		rubric: dataset.rubric,
		training_examples: dataset.training_examples.map((example) => ({
			input: example.input,
			answer: example.answer,
			...(example.additional_context === undefined
				? {}
				: { additional_context: example.additional_context }),
		})),
		validation_examples: dataset.validation_examples.map((example) => ({
			input: example.input,
			answer: example.answer,
			...(example.additional_context === undefined
				? {}
				: { additional_context: example.additional_context }),
		})),
	};
}

export function hashOptimizationDataset(dataset: OptimizationDataset): string {
	return createHash("sha256")
		.update(canonicalJson(canonicalDataset(dataset)))
		.digest("hex");
}

export function normalizeOptimizationInput(value: string): string {
	return rectifyConfusion(
		value
			.normalize("NFKD")
			.toUpperCase()
			.replace(/[\p{Cc}\p{Cf}\p{M}\p{Default_Ignorable_Code_Point}]/gu, ""),
	)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\p{Cc}\p{Cf}\p{M}\p{Default_Ignorable_Code_Point}]/gu, "")
		.trim()
		.replace(/\s+/gu, " ");
}

export function hasOverlappingOptimizationInputs(
	dataset: Pick<
		OptimizationDataset,
		"training_examples" | "validation_examples"
	>,
): boolean {
	const trainingInputs = dataset.training_examples.map((example) =>
		normalizeOptimizationInput(example.input),
	);
	const validationInputs = dataset.validation_examples.map((example) =>
		normalizeOptimizationInput(example.input),
	);
	for (const inputs of [trainingInputs, validationInputs]) {
		for (let index = 0; index < inputs.length; index += 1) {
			if (
				inputs
					.slice(0, index)
					.some((prior) => inputsMateriallyOverlap(prior, inputs[index]!))
			) {
				return true;
			}
		}
	}
	for (const trainingInput of trainingInputs) {
		if (
			validationInputs.some((validationInput) =>
				inputsMateriallyOverlap(trainingInput, validationInput),
			)
		) {
			return true;
		}
	}
	return false;
}

function inputsMateriallyOverlap(left: string, right: string): boolean {
	if (left === right) return true;
	const leftTokens = left.match(/[\p{L}\p{N}]+/gu) ?? [];
	const rightTokens = right.match(/[\p{L}\p{N}]+/gu) ?? [];
	const [shorter, longer] =
		leftTokens.length <= rightTokens.length
			? [leftTokens, rightTokens]
			: [rightTokens, leftTokens];
	if (shorter.length === 0) return false;
	if (` ${longer.join(" ")} `.includes(` ${shorter.join(" ")} `)) return true;
	const longerCounts = new Map<string, number>();
	for (const token of longer)
		longerCounts.set(token, (longerCounts.get(token) ?? 0) + 1);
	let shared = 0;
	for (const token of shorter) {
		const remaining = longerCounts.get(token) ?? 0;
		if (remaining === 0) continue;
		shared += 1;
		longerCounts.set(token, remaining - 1);
	}
	return shared / shorter.length >= 0.8;
}

export function automaticPromotionReason(
	evidence: OptimizationEvidence,
):
	| "insufficient_held_out_validation"
	| "held_out_score_unavailable"
	| "held_out_score_did_not_improve"
	| null {
	if (evidence.validation.sample_count < MIN_AUTOMATIC_VALIDATION_EXAMPLES)
		return "insufficient_held_out_validation";
	if (
		evidence.validation.score === null ||
		evidence.validation.baseline_score === null
	)
		return "held_out_score_unavailable";
	if (evidence.validation.score <= evidence.validation.baseline_score)
		return "held_out_score_did_not_improve";
	return null;
}
