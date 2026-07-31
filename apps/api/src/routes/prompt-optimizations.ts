import { randomUUID } from "node:crypto";
import { rectifyConfusion } from "unicode-confusables";
import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import {
	claimOptimizationJob,
	completeOptimizationResult,
	createOptimizationJob,
	getActiveOptimizationJob,
	getLatestOptimizationJob,
	getOptimizationJob,
	listActiveOptimizationActivities,
	listOptimizationEvents,
	optimizationSourceMessages,
	promoteOptimizationDraft,
	publishOptimizationResult,
	recordOptimizationMetricCalls,
	renewOptimizationJobLease,
	stopOptimizationJob,
	transitionOptimizationJob,
	type OptimizationJob,
} from "../db/prompt-optimizations.js";
import { pgPool } from "../db/postgres.js";
import { PromptRepositoryError } from "../db/prompts.js";
import type { JsonObject } from "../db/prompts.js";
import {
	MAX_OPTIMIZATION_CANDIDATE_BYTES,
	runGepaWorker,
	type GepaWorker,
} from "../lib/gepa-worker.js";
import {
	automaticPromotionReason,
	hasOverlappingOptimizationInputs,
	type OptimizationDataset,
	type OptimizationEvidence,
	type OptimizationLeakage,
} from "../lib/optimization-dataset.js";
import { hasMatchingMustacheTokenSignature } from "../lib/prompt-tokens.js";
import {
	GepaConfigurationError,
	MAX_GEPA_METRIC_CALLS,
	MIN_GEPA_METRIC_CALLS,
	validateGepaConfiguration,
} from "../lib/gepa-config.js";
import { validatePromptTemplate } from "../lib/prompt-templates.js";
import { TRUSTED_ACTOR_CONTEXT_KEY } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";
import {
	PromptErrorResponses,
	ProjectIdQuery,
	PromptId,
} from "../schemas/prompts.js";

const tag = "prompt-optimization";
const Status = z.enum([
	"queued",
	"preparing",
	"optimizing",
	"evaluating",
	"completed",
	"stopped",
	"failed",
]);
const JsonObject = z.record(z.string(), z.unknown());
const Evaluator = z.object({ type: z.literal("default_adapter") }).strict();
const Example = z
	.object({
		input: z.string().trim().min(1).max(12_000),
		answer: z.string().trim().min(1).max(12_000),
		additional_context: JsonObject.optional(),
	})
	.strict();
const Dataset = z
	.object({
		version: z.literal(1),
		rubric: z.string().trim().min(1).max(2_000),
		training_examples: z.array(Example).min(1).max(25),
		validation_examples: z.array(Example).min(1).max(25),
	})
	.strict();
const LegacyDataset = z
	.object({
		version: z.literal(0),
		rubric: z.string(),
		training_examples: z.array(Example),
		validation_examples: z.array(Example),
	})
	.strict();
const MetricEvidence = z
	.object({
		metric: z.literal("default_adapter.expected_answer_contains"),
		rubric: z.string(),
		training: z
			.object({
				sample_count: z.number().int().nonnegative(),
				score: z.number().finite().nullable(),
			})
			.strict(),
		validation: z
			.object({
				sample_count: z.number().int().nonnegative(),
				score: z.number().finite().nullable(),
				baseline_score: z.number().finite().nullable(),
				held_out: z.literal(true),
			})
			.strict(),
		leakage: z
			.object({
				status: z.enum(["not_run", "passed", "failed"]),
				reason: z
					.enum(["expected_answer_full_match", "expected_answer_material_span"])
					.nullable(),
			})
			.strict(),
	})
	.strict();
const PromotionStatus = z.enum([
	"pending",
	"auto_promoted",
	"review_required",
	"blocked",
	"reviewed_promoted",
	"legacy",
]);
const ModelConfig = z
	.object({ task_lm: z.string().min(1), reflection_lm: z.string().min(1) })
	.strict();
const Budget = z
	.object({
		max_metric_calls: z
			.number()
			.int()
			.min(MIN_GEPA_METRIC_CALLS)
			.max(MAX_GEPA_METRIC_CALLS),
	})
	.strict();
const Job = z
	.object({
		id: z.string().uuid(),
		project_id: z.string().uuid(),
		prompt_id: z.string().uuid(),
		prompt_slug: PromptId,
		source_version: z.number().int().positive(),
		target: z.enum(["system", "user"]),
		evaluator: JsonObject,
		dataset: z.union([Dataset, LegacyDataset]),
		dataset_hash: z.string().regex(/^[a-f0-9]{64}$/),
		model_config: JsonObject,
		budget: JsonObject,
		status: Status,
		requested_by: z.string(),
		result_version: z.number().int().positive().nullable(),
		candidate_content: z.string().nullable(),
		evidence: MetricEvidence.nullable(),
		promotion_status: PromotionStatus,
		promotion_reason: z.string().nullable(),
		reviewed_by: z.string().nullable(),
		promoted_at: z.string().datetime().nullable(),
		error_message: z.string().nullable(),
		metric_calls_used: z.number().int().nonnegative().nullable(),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
		completed_at: z.string().datetime().nullable(),
	})
	.strict();
const DatasetSummary = z
	.object({
		version: z.union([z.literal(0), z.literal(1)]),
		rubric: z.string(),
		training_example_count: z.number().int().nonnegative(),
		validation_example_count: z.number().int().nonnegative(),
	})
	.strict();
const PublicJob = Job.pick({
	id: true,
	prompt_slug: true,
	source_version: true,
	target: true,
	dataset_hash: true,
	budget: true,
	status: true,
	result_version: true,
	candidate_content: true,
	evidence: true,
	promotion_status: true,
	promotion_reason: true,
	promoted_at: true,
	error_message: true,
	metric_calls_used: true,
	created_at: true,
	updated_at: true,
	completed_at: true,
})
	.extend({ dataset: DatasetSummary })
	.strict();
const JobId = z
	.object({
		id: z
			.string()
			.uuid()
			.openapi({ param: { name: "id", in: "path" } }),
	})
	.strict();
const JobStatus = Job.pick({
	id: true,
	prompt_slug: true,
	source_version: true,
	target: true,
	budget: true,
	status: true,
	result_version: true,
	error_message: true,
	metric_calls_used: true,
	created_at: true,
	updated_at: true,
	completed_at: true,
}).strict();
const ActiveQuery = z
	.object({ project_id: z.string().uuid(), slug: PromptId })
	.strict();
const ActivitiesQuery = z.object({ project_id: z.string().uuid() }).strict();
const Activity = z
	.object({
		id: z.string().uuid(),
		prompt_slug: PromptId,
		source_version: z.number().int().positive(),
		target: z.enum(["system", "user"]),
		status: Status.exclude(["completed", "stopped", "failed"]),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
	})
	.strict();
const Activities = z.object({ items: z.array(Activity) }).strict();
const Start = z
	.object({
		project_id: z.string().uuid(),
		slug: PromptId,
		source_version: z.number().int().positive(),
		target: z.enum(["system", "user"]),
		evaluator: Evaluator,
		dataset: Dataset,
		model_config: ModelConfig,
		budget: Budget,
	})
	.strict();

export const startOptimization = createRoute({
	method: "post",
	path: "/v1/prompt-optimizations",
	tags: [tag],
	summary: "Start a GEPA prompt optimization",
	security: [{ basicAuth: [] }],
	request: { body: { content: { "application/json": { schema: Start } } } },
	responses: {
		202: {
			description: "Queued",
			content: { "application/json": { schema: PublicJob } },
		},
		...PromptErrorResponses,
	},
});

export const getOptimization = createRoute({
	method: "get",
	path: "/v1/prompt-optimizations/{id}",
	tags: [tag],
	security: [{ basicAuth: [] }],
	request: { params: JobId, query: ProjectIdQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: PublicJob } },
		},
		...PromptErrorResponses,
	},
});

export const getActiveOptimization = createRoute({
	method: "get",
	path: "/v1/prompt-optimizations/active",
	tags: [tag],
	security: [{ basicAuth: [] }],
	request: { query: ActiveQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: PublicJob.nullable() } },
		},
		...PromptErrorResponses,
	},
});
export const getLatestOptimization = createRoute({
	method: "get",
	path: "/v1/prompt-optimizations/latest",
	tags: [tag],
	security: [{ basicAuth: [] }],
	request: { query: ActiveQuery },
	responses: {
		200: {
			description:
				"Latest optimization for the prompt, prioritizing active work",
			content: { "application/json": { schema: JobStatus.nullable() } },
		},
		...PromptErrorResponses,
	},
});
export const listOptimizationActivities = createRoute({
	method: "get",
	path: "/v1/prompt-optimizations/activities",
	tags: [tag],
	security: [{ basicAuth: [] }],
	request: { query: ActivitiesQuery },
	responses: {
		200: {
			description: "Current active optimization activity for each prompt",
			content: { "application/json": { schema: Activities } },
		},
		...PromptErrorResponses,
	},
});
export const promoteOptimization = createRoute({
	method: "post",
	path: "/v1/prompt-optimizations/{id}/promote",
	tags: [tag],
	summary: "Promote a reviewed GEPA draft",
	security: [{ basicAuth: [] }],
	request: { params: JobId, query: ProjectIdQuery },
	responses: {
		200: {
			description: "Promoted",
			content: { "application/json": { schema: PublicJob } },
		},
		...PromptErrorResponses,
	},
});
export const stopOptimization = createRoute({
	method: "post",
	path: "/v1/prompt-optimizations/{id}/stop",
	tags: [tag],
	security: [{ basicAuth: [] }],
	request: { params: JobId, query: ProjectIdQuery },
	responses: {
		200: {
			description: "Stopped",
			content: { "application/json": { schema: PublicJob } },
		},
		...PromptErrorResponses,
	},
});

export const optimizationEvents = createRoute({
	method: "get",
	path: "/v1/prompt-optimizations/{id}/events",
	tags: [tag],
	security: [{ basicAuth: [] }],
	request: { params: JobId, query: ProjectIdQuery },
	responses: {
		200: {
			description: "SSE events",
			content: { "text/event-stream": { schema: z.string() } },
		},
		...PromptErrorResponses,
	},
});

function error(
	c: { json: (body: unknown, status: 400 | 404 | 409 | 500) => Response },
	cause: unknown,
): Response {
	const known =
		cause instanceof PromptRepositoryError
			? cause
			: cause instanceof GepaConfigurationError
				? new PromptRepositoryError("BAD_REQUEST", cause.message)
				: new PromptRepositoryError("INTERNAL", "Optimization failed");
	return c.json(
		{
			code: known.code,
			message:
				known.code === "INTERNAL" ? "Optimization failed" : known.message,
		},
		known.status,
	);
}

function actor(c: { get: (key: string) => unknown }): string {
	const value = c.get(TRUSTED_ACTOR_CONTEXT_KEY);
	if (typeof value !== "string")
		throw new PromptRepositoryError("INTERNAL", "Trusted actor is unavailable");
	return value;
}

export type OptimizationDependencies = {
	pool: typeof pgPool;
	worker: GepaWorker;
	create: typeof createOptimizationJob;
	get: typeof getOptimizationJob;
	getActive: typeof getActiveOptimizationJob;
	getLatest: typeof getLatestOptimizationJob;
	listActivities: typeof listActiveOptimizationActivities;
	claim: typeof claimOptimizationJob;
	renew: typeof renewOptimizationJobLease;
	sourceMessages: typeof optimizationSourceMessages;
	events: typeof listOptimizationEvents;
	stop: typeof stopOptimizationJob;
	transition: typeof transitionOptimizationJob;
	complete: typeof completeOptimizationResult;
	publish: typeof publishOptimizationResult;
	recordMetricCalls: typeof recordOptimizationMetricCalls;
	promote: typeof promoteOptimizationDraft;
};

const activeWorkers = new Map<string, AbortController>();
const workerId = randomUUID();
const terminalStatuses = new Set<OptimizationJob["status"]>([
	"completed",
	"stopped",
	"failed",
]);

export function nextOptimizationEvents(
	events: Awaited<ReturnType<typeof listOptimizationEvents>>,
	lastId: number,
): {
	events: Awaited<ReturnType<typeof listOptimizationEvents>>;
	lastId: number;
	terminal: boolean;
} {
	const unseen = [] as Awaited<ReturnType<typeof listOptimizationEvents>>;
	let terminal = false;
	for (const event of events) {
		if (event.id <= lastId) continue;
		unseen.push(event);
		if (terminalStatuses.has(event.status)) {
			terminal = true;
			break;
		}
	}
	return {
		events: unseen,
		lastId: unseen.at(-1)?.id ?? lastId,
		terminal,
	};
}

export async function renewOptimizationLease(input: {
	job_id: string;
	controller: AbortController;
	renew: () => Promise<boolean>;
}): Promise<void> {
	try {
		if (!(await input.renew())) input.controller.abort();
	} catch (cause) {
		logger.error("optimization.lease_renewal_failed", cause, {
			job_id: input.job_id,
		});
		input.controller.abort();
	}
}

function normalizedVisibleText(value: string): string {
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

function normalizedLeakageText(value: string): string {
	return (normalizedVisibleText(value).match(/[\p{L}\p{N}]+/gu) ?? []).join(
		" ",
	);
}

function compactLeakageText(value: string): string {
	return (normalizedVisibleText(value).match(/[\p{L}\p{N}]+/gu) ?? []).join("");
}

function containsCompactFullAnswer(
	visibleCandidate: string,
	compactAnswer: string,
): boolean {
	if (!compactAnswer) return false;
	const separator = "[^\\p{L}\\p{N}]*";
	const body = Array.from(compactAnswer)
		.map((character) => character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"))
		.join(separator);
	return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "u").test(
		visibleCandidate,
	);
}

function tokenCounts(tokens: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

type ComparisonBudget = { comparisons: number; exhausted: boolean };

function consumeComparison(budget: ComparisonBudget): boolean {
	budget.comparisons += 1;
	if (budget.comparisons <= 250_000) return true;
	budget.exhausted = true;
	return false;
}

function containsTokenMultiset(
	candidateTokenCounts: Map<string, number>,
	expectedTokens: string[],
	budget: ComparisonBudget,
): boolean {
	const expectedTokenCounts = new Map<string, number>();
	for (const token of expectedTokens) {
		if (!consumeComparison(budget)) return true;
		const expectedCount = (expectedTokenCounts.get(token) ?? 0) + 1;
		if ((candidateTokenCounts.get(token) ?? 0) < expectedCount) return false;
		expectedTokenCounts.set(token, expectedCount);
	}
	return true;
}

function containsOrderedMaterial(
	candidateTokens: string[],
	expectedTokens: string[],
	budget: ComparisonBudget,
): boolean {
	// Filler words cannot make an ordered copy of an expected-answer span safe.
	const positions = new Map<string, number[]>();
	for (const [index, token] of candidateTokens.entries()) {
		const indexes = positions.get(token) ?? [];
		indexes.push(index);
		positions.set(token, indexes);
	}
	for (
		let expectedStart = 0;
		expectedStart < expectedTokens.length;
		expectedStart += 1
	) {
		const startingToken = expectedTokens[expectedStart]!;
		for (const candidateStart of positions.get(startingToken) ?? []) {
			let candidateIndex = candidateStart;
			let spanLength = startingToken.length;
			for (
				let expectedIndex = expectedStart + 1;
				expectedIndex < expectedTokens.length;
				expectedIndex += 1
			) {
				if (!consumeComparison(budget)) return true;
				const next = firstPositionAfter(
					positions.get(expectedTokens[expectedIndex]!) ?? [],
					candidateIndex,
				);
				if (next === null) break;
				candidateIndex = next;
				spanLength += expectedTokens[expectedIndex]!.length + 1;
				if (expectedIndex - expectedStart + 1 >= 8 && spanLength >= 48)
					return true;
			}
		}
	}
	return false;
}

function segmentedTokenSkeleton(token: string): string {
	return token.replace(/rn/gu, "m");
}

// Handle multi-character confusables such as m -> rn without trusting one skeleton.
function tokensWithinLeakageDistance(
	left: string,
	right: string,
	budget: ComparisonBudget,
): boolean {
	if (left === right) return true;
	left = segmentedTokenSkeleton(left);
	right = segmentedTokenSkeleton(right);
	if (left === right) return true;
	if (
		left.length < 4 ||
		right.length < 4 ||
		Math.abs(left.length - right.length) > 2
	)
		return false;
	const previous = Array.from(
		{ length: right.length + 1 },
		(_, index) => index,
	);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		const next = [leftIndex];
		let rowMinimum = next[0]!;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			if (!consumeComparison(budget)) return false;
			const distance = Math.min(
				next[rightIndex - 1]! + 1,
				previous[rightIndex]! + 1,
				previous[rightIndex - 1]! +
					(left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
			next.push(distance);
			rowMinimum = Math.min(rowMinimum, distance);
		}
		if (rowMinimum > 2) return false;
		previous.splice(0, previous.length, ...next);
	}
	return previous[right.length]! <= 2;
}

function containsFuzzyOrderedTokens(
	candidateTokens: string[],
	expectedTokens: string[],
	budget: ComparisonBudget,
): boolean {
	if (!expectedTokens.length) return false;
	const positions = new Map<string, number[]>();
	const positionsFor = (expectedToken: string): number[] | null => {
		const known = positions.get(expectedToken);
		if (known) return known;
		const matches: number[] = [];
		for (const [index, candidateToken] of candidateTokens.entries()) {
			if (tokensWithinLeakageDistance(candidateToken, expectedToken, budget))
				matches.push(index);
			if (budget.exhausted) return null;
		}
		positions.set(expectedToken, matches);
		return matches;
	};
	for (const candidateStart of positionsFor(expectedTokens[0]!) ?? []) {
		let candidateIndex = candidateStart;
		let matched = true;
		for (
			let expectedIndex = 1;
			expectedIndex < expectedTokens.length;
			expectedIndex += 1
		) {
			const matches = positionsFor(expectedTokens[expectedIndex]!);
			if (matches === null) return true;
			const next = firstPositionAfter(matches, candidateIndex);
			if (next === null) {
				matched = false;
				break;
			}
			candidateIndex = next;
		}
		if (matched) return true;
	}
	return budget.exhausted;
}

function firstPositionAfter(positions: number[], index: number): number | null {
	let low = 0;
	let high = positions.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (positions[middle]! > index) high = middle;
		else low = middle + 1;
	}
	return positions[low] ?? null;
}

export function checkExpectedAnswerLeakage(
	candidate: string,
	expectedAnswers: string[],
): OptimizationLeakage {
	const normalizedCandidate = normalizedLeakageText(candidate);
	const candidateTokens = normalizedCandidate
		? normalizedCandidate.split(" ")
		: [];
	const candidateTokenCounts = tokenCounts(candidateTokens);
	const paddedCandidate = ` ${normalizedCandidate} `;
	const compactCandidate = compactLeakageText(candidate);
	const visibleCandidate = normalizedVisibleText(candidate);
	const budget = { comparisons: 0, exhausted: false };
	for (const answer of expectedAnswers) {
		const visibleAnswer = normalizedVisibleText(answer);
		const normalizedAnswer = normalizedLeakageText(answer);
		const answerTokens = normalizedAnswer ? normalizedAnswer.split(" ") : [];
		const paddedAnswer = ` ${normalizedAnswer} `;
		const compactAnswer = compactLeakageText(answer);
		if (
			(visibleAnswer &&
				answerTokens.length === 0 &&
				visibleCandidate.includes(visibleAnswer)) ||
			(answerTokens.length > 0 &&
				(paddedCandidate.includes(paddedAnswer) ||
					containsCompactFullAnswer(visibleCandidate, compactAnswer) ||
					containsTokenMultiset(candidateTokenCounts, answerTokens, budget) ||
					containsFuzzyOrderedTokens(candidateTokens, answerTokens, budget)))
		)
			return { status: "failed", reason: "expected_answer_full_match" };
		for (let start = 0; start <= answerTokens.length - 8; start += 1) {
			let end = start + 8;
			let spanLength = answerTokens.slice(start, end).join(" ").length;
			while (spanLength < 48 && end < answerTokens.length) {
				spanLength += answerTokens[end]!.length + 1;
				end += 1;
			}
			if (spanLength < 48) continue;
			const spanTokens = answerTokens.slice(start, end);
			const span = spanTokens.join(" ");
			if (
				paddedCandidate.includes(` ${span} `) ||
				compactCandidate.includes(spanTokens.join("")) ||
				containsOrderedMaterial(candidateTokens, spanTokens, budget) ||
				containsTokenMultiset(candidateTokenCounts, spanTokens, budget) ||
				containsFuzzyOrderedTokens(candidateTokens, spanTokens, budget)
			)
				return {
					status: "failed",
					reason: "expected_answer_material_span",
				};
		}
	}
	return { status: "passed", reason: null };
}

export function validateGepaCandidate(
	original: string,
	candidate: string,
	expectedAnswers: string[] = [],
	exampleInputs: string[] = [],
): OptimizationLeakage {
	if (
		new TextEncoder().encode(candidate).byteLength >
		MAX_OPTIMIZATION_CANDIDATE_BYTES
	)
		throw new PromptRepositoryError(
			"BAD_REQUEST",
			"GEPA candidate exceeded size limit",
		);
	try {
		validatePromptTemplate(candidate);
	} catch (cause) {
		throw new PromptRepositoryError(
			"BAD_REQUEST",
			cause instanceof Error ? cause.message : "GEPA candidate is invalid",
		);
	}
	if (!hasMatchingMustacheTokenSignature(original, candidate))
		throw new PromptRepositoryError(
			"BAD_REQUEST",
			"GEPA candidate changed Mustache tokens",
		);
	const leakage = checkExpectedAnswerLeakage(candidate, expectedAnswers);
	if (leakage.status === "failed")
		throw new PromptRepositoryError(
			"BAD_REQUEST",
			"GEPA candidate contains expected-answer material",
		);
	if (checkExpectedAnswerLeakage(candidate, exampleInputs).status === "failed")
		throw new PromptRepositoryError(
			"BAD_REQUEST",
			"GEPA candidate contains example input material",
		);
	return leakage;
}

type OptimizationDatasetExamples = Pick<
	OptimizationDataset,
	"training_examples" | "validation_examples"
>;

function expectedAnswers(dataset: OptimizationDatasetExamples): string[] {
	return [...dataset.training_examples, ...dataset.validation_examples].map(
		(example) => example.answer,
	);
}

function exampleInputs(dataset: OptimizationDatasetExamples): string[] {
	return [...dataset.training_examples, ...dataset.validation_examples].map(
		(example) => example.input,
	);
}

function containsProtectedExampleMaterial(
	candidate: string,
	dataset: OptimizationDatasetExamples,
): boolean {
	return (
		checkExpectedAnswerLeakage(candidate, [
			...expectedAnswers(dataset),
			...exampleInputs(dataset),
		]).status === "failed"
	);
}

function evidenceFor(
	dataset: OptimizationDataset,
	result: Awaited<ReturnType<GepaWorker>>,
	leakage: OptimizationLeakage,
): OptimizationEvidence {
	return {
		metric: "default_adapter.expected_answer_contains",
		rubric: dataset.rubric,
		training: {
			sample_count: dataset.training_examples.length,
			score: result.training_score,
		},
		validation: {
			sample_count: dataset.validation_examples.length,
			score: result.validation_score,
			baseline_score: result.baseline_validation_score,
			held_out: true,
		},
		leakage,
	};
}

const production: OptimizationDependencies = {
	pool: pgPool,
	worker: runGepaWorker,
	create: createOptimizationJob,
	get: getOptimizationJob,
	getActive: getActiveOptimizationJob,
	getLatest: getLatestOptimizationJob,
	listActivities: listActiveOptimizationActivities,
	claim: claimOptimizationJob,
	renew: renewOptimizationJobLease,
	sourceMessages: optimizationSourceMessages,
	events: listOptimizationEvents,
	stop: stopOptimizationJob,
	transition: transitionOptimizationJob,
	complete: completeOptimizationResult,
	publish: publishOptimizationResult,
	recordMetricCalls: recordOptimizationMetricCalls,
	promote: promoteOptimizationDraft,
};

function publicJob(job: OptimizationJob) {
	const candidateContent =
		job.candidate_content &&
		containsProtectedExampleMaterial(job.candidate_content, job.dataset)
			? null
			: job.candidate_content;
	return {
		id: job.id,
		prompt_slug: job.prompt_slug,
		source_version: job.source_version,
		target: job.target,
		dataset: {
			version: job.dataset.version,
			rubric: job.dataset.rubric,
			training_example_count: job.dataset.training_examples.length,
			validation_example_count: job.dataset.validation_examples.length,
		},
		dataset_hash: job.dataset_hash,
		budget: job.budget,
		status: job.status,
		result_version: job.result_version,
		candidate_content: candidateContent,
		evidence: job.evidence,
		promotion_status: job.promotion_status,
		promotion_reason: job.promotion_reason,
		promoted_at: job.promoted_at,
		error_message: job.error_message,
		metric_calls_used: job.metric_calls_used,
		created_at: job.created_at,
		updated_at: job.updated_at,
		completed_at: job.completed_at,
	};
}

function statusSnapshot(job: OptimizationJob | null) {
	if (!job) return null;
	return {
		id: job.id,
		prompt_slug: job.prompt_slug,
		source_version: job.source_version,
		target: job.target,
		budget: job.budget,
		status: job.status,
		result_version: job.result_version,
		error_message: job.error_message,
		metric_calls_used: job.metric_calls_used,
		created_at: job.created_at,
		updated_at: job.updated_at,
		completed_at: job.completed_at,
	};
}

function metricCallsUsed(
	job: OptimizationJob,
	result: Awaited<ReturnType<GepaWorker>>,
): number | null {
	const value = result.metric_calls_used;
	if (value === null || value === undefined) return null;
	const budget = job.budget.max_metric_calls;
	if (typeof budget !== "number" || !Number.isSafeInteger(budget))
		throw new PromptRepositoryError(
			"BAD_REQUEST",
			"Optimization job has an invalid metric-call budget",
		);
	if (!Number.isSafeInteger(value) || value < 0 || value > budget)
		throw new PromptRepositoryError(
			"BAD_REQUEST",
			"GEPA worker reported an invalid metric-call count",
		);
	return value;
}

export async function runOptimizationJob(
	job: OptimizationJob,
	d: OptimizationDependencies,
): Promise<void> {
	if (activeWorkers.has(job.id)) {
		logger.debug("optimization.already_running", { job_id: job.id });
		return;
	}
	if (!(await d.claim(d.pool(), { id: job.id, worker_id: workerId }))) {
		logger.debug("optimization.claim_not_owned", { job_id: job.id });
		return;
	}
	const startedAt = performance.now();
	const controller = new AbortController();
	logger.info("optimization.claimed", {
		job_id: job.id,
		project_id: job.project_id,
		prompt_slug: job.prompt_slug,
		target: job.target,
		worker_id: workerId,
	});
	activeWorkers.set(job.id, controller);
	const leaseRenewal = setInterval(() => {
		void renewOptimizationLease({
			job_id: job.id,
			controller,
			renew: () => d.renew(d.pool(), { id: job.id, worker_id: workerId }),
		});
	}, 60_000);
	try {
		if (job.dataset.version !== 1)
			throw new PromptRepositoryError(
				"BAD_REQUEST",
				"Legacy optimization jobs cannot be resumed",
			);
		await d.transition(d.pool(), {
			id: job.id,
			worker_id: workerId,
			status: "preparing",
			detail: {
				target: job.target,
				source_version: job.source_version,
				dataset_version: job.dataset.version,
				training_sample_count: job.dataset.training_examples.length,
				validation_sample_count: job.dataset.validation_examples.length,
				max_metric_calls: job.budget.max_metric_calls ?? null,
			},
		});
		logger.info("optimization.preparing", { job_id: job.id });
		const sourceMessages = await d.sourceMessages(d.pool(), {
			project_id: job.project_id,
			id: job.id,
		});
		const original = sourceMessages.find((item) => item.role === job.target);
		if (!original)
			throw new PromptRepositoryError(
				"BAD_REQUEST",
				`Source prompt has no ${job.target} message`,
			);
		await d.transition(d.pool(), {
			id: job.id,
			worker_id: workerId,
			status: "optimizing",
		});
		logger.info("optimization.worker_started", {
			job_id: job.id,
			target: job.target,
			models: job.model_config,
			max_metric_calls: job.budget,
		});
		const result = await d.worker(
			{
				target: job.target,
				source: original.content,
				evaluator: job.evaluator,
				dataset: job.dataset,
				model_config: job.model_config,
				budget: job.budget,
			},
			controller.signal,
		);
		const usedMetricCalls = metricCallsUsed(job, result);
		if (usedMetricCalls !== null)
			await d.recordMetricCalls(d.pool(), {
				id: job.id,
				worker_id: workerId,
				metric_calls_used: usedMetricCalls,
			});
		const leakage = checkExpectedAnswerLeakage(
			result.candidate,
			expectedAnswers(job.dataset),
		);
		const evidence = evidenceFor(job.dataset, result, leakage);
		logger.info("optimization.worker_completed", {
			job_id: job.id,
			duration_ms: Math.round(performance.now() - startedAt),
			training_score: result.training_score,
			validation_score: result.validation_score,
			baseline_validation_score: result.baseline_validation_score,
			metric_calls_used: usedMetricCalls,
			candidate_bytes: new TextEncoder().encode(result.candidate).byteLength,
		});
		await d.transition(d.pool(), {
			id: job.id,
			worker_id: workerId,
			status: "evaluating",
			detail: {
				metric: evidence.metric,
				training_sample_count: evidence.training.sample_count,
				validation_sample_count: evidence.validation.sample_count,
				...(usedMetricCalls === null
					? {}
					: { metric_calls_used: usedMetricCalls }),
			},
			metric_calls_used: usedMetricCalls,
		});
		try {
			validateGepaCandidate(
				original.content,
				result.candidate,
				expectedAnswers(job.dataset),
				exampleInputs(job.dataset),
			);
		} catch {
			const reason = leakage.reason ?? "candidate_validation_failed";
			await d.complete(d.pool(), {
				id: job.id,
				worker_id: workerId,
				candidate_content: null,
				evidence,
				promotion_status: "blocked",
				promotion_reason: reason,
			});
			logger.warn("optimization.candidate_blocked", {
				job_id: job.id,
				promotion_reason: reason,
				leakage_status: leakage.status,
			});
			return;
		}
		const promotionReason = automaticPromotionReason(evidence);
		if (promotionReason !== null) {
			await d.complete(d.pool(), {
				id: job.id,
				worker_id: workerId,
				candidate_content: result.candidate,
				evidence,
				promotion_status: "review_required",
				promotion_reason: promotionReason,
			});
			logger.info("optimization.completed", {
				job_id: job.id,
				duration_ms: Math.round(performance.now() - startedAt),
				promotion_status: "review_required",
				promotion_reason: promotionReason,
			});
			return;
		}
		try {
			await d.publish(d.pool(), {
				id: job.id,
				worker_id: workerId,
				evidence,
				messages: sourceMessages.map((item) =>
					item.role === job.target
						? { ...item, content: result.candidate }
						: item,
				),
			});
		} catch (cause) {
			if (
				cause instanceof PromptRepositoryError &&
				cause.code === "CONFLICT" &&
				cause.message.startsWith("Source prompt version is no longer current")
			) {
				await d.complete(d.pool(), {
					id: job.id,
					worker_id: workerId,
					candidate_content: result.candidate,
					evidence,
					promotion_status: "review_required",
					promotion_reason: "source_version_is_stale",
				});
				logger.info("optimization.completed", {
					job_id: job.id,
					duration_ms: Math.round(performance.now() - startedAt),
					promotion_status: "review_required",
					promotion_reason: "source_version_is_stale",
				});
				return;
			}
			throw cause;
		}
		logger.info("optimization.completed", {
			job_id: job.id,
			duration_ms: Math.round(performance.now() - startedAt),
			promotion_status: "auto_promoted",
		});
	} catch (cause) {
		logger.error("optimization.failed", cause, {
			job_id: job.id,
			project_id: job.project_id,
			prompt_slug: job.prompt_slug,
			duration_ms: Math.round(performance.now() - startedAt),
		});
		try {
			await d.transition(d.pool(), {
				id: job.id,
				worker_id: workerId,
				status: "failed",
				error_message:
					cause instanceof Error
						? cause.message.slice(0, 240)
						: "Worker failed",
			});
		} catch {
			// A stopped or completed job is terminal and wins every worker failure race.
		}
	} finally {
		clearInterval(leaseRenewal);
		if (activeWorkers.get(job.id) === controller) activeWorkers.delete(job.id);
	}
}

export function createOptimizationHandlers(
	d: OptimizationDependencies = production,
) {
	return {
		handleStart: async (
			c: Parameters<RouteHandler<typeof startOptimization>>[0],
		): Promise<Response> => {
			try {
				const body = c.req.valid("json") as {
					project_id: string;
					slug: string;
					source_version: number;
					target: "system" | "user";
					evaluator: JsonObject;
					dataset: OptimizationDataset;
					model_config: JsonObject;
					budget: JsonObject;
				};
				if (hasOverlappingOptimizationInputs(body.dataset))
					throw new PromptRepositoryError(
						"BAD_REQUEST",
						"Training and held-out validation inputs must be unique and non-overlapping",
					);
				validateGepaConfiguration({
					model_config: body.model_config as {
						task_lm: string;
						reflection_lm: string;
					},
					budget: body.budget as { max_metric_calls: number },
				});
				const job = await d.create(d.pool(), { ...body, actor: actor(c) });
				logger.info("optimization.accepted", {
					job_id: job.id,
					project_id: job.project_id,
					prompt_slug: job.prompt_slug,
					source_version: job.source_version,
					target: job.target,
					dataset_version: job.dataset.version,
					training_sample_count: body.dataset.training_examples.length,
					validation_sample_count: body.dataset.validation_examples.length,
					models: body.model_config,
					budget: body.budget,
				});
				void runOptimizationJob(job, d);
				return c.json(publicJob(job), 202);
			} catch (cause) {
				return error(c, cause);
			}
		},
		handleGet: async (
			c: Parameters<RouteHandler<typeof getOptimization>>[0],
		): Promise<Response> => {
			try {
				const job = await d.get(d.pool(), {
					project_id: (c.req.valid("query") as { project_id: string })
						.project_id,
					id: (c.req.valid("param") as { id: string }).id,
				});
				return c.json(publicJob(job));
			} catch (cause) {
				return error(c, cause);
			}
		},
		handleGetActive: async (
			c: Parameters<RouteHandler<typeof getActiveOptimization>>[0],
		): Promise<Response> => {
			try {
				const job = await d.getActive(
					d.pool(),
					c.req.valid("query") as { project_id: string; slug: string },
				);
				return c.json(job ? publicJob(job) : null);
			} catch (cause) {
				return error(c, cause);
			}
		},
		handleGetLatest: async (
			c: Parameters<RouteHandler<typeof getLatestOptimization>>[0],
		): Promise<Response> => {
			try {
				return c.json(
					statusSnapshot(
						await d.getLatest(
							d.pool(),
							c.req.valid("query") as { project_id: string; slug: string },
						),
					),
				);
			} catch (cause) {
				return error(c, cause);
			}
		},
		handleListActivities: async (
			c: Parameters<RouteHandler<typeof listOptimizationActivities>>[0],
		): Promise<Response> => {
			try {
				return c.json({
					items: await d.listActivities(
						d.pool(),
						c.req.valid("query") as { project_id: string },
					),
				});
			} catch (cause) {
				return error(c, cause);
			}
		},
		handlePromote: async (
			c: Parameters<RouteHandler<typeof promoteOptimization>>[0],
		): Promise<Response> => {
			try {
				const input = {
					project_id: (c.req.valid("query") as { project_id: string })
						.project_id,
					id: (c.req.valid("param") as { id: string }).id,
				};
				const job = await d.get(d.pool(), input);
				if (job.dataset.version !== 1 || job.candidate_content === null)
					throw new PromptRepositoryError(
						"CONFLICT",
						"Optimization draft is not eligible for promotion",
					);
				const sourceMessages = await d.sourceMessages(d.pool(), input);
				const original = sourceMessages.find(
					(message) => message.role === job.target,
				);
				if (!original)
					throw new PromptRepositoryError(
						"CONFLICT",
						"Optimization draft is not eligible for promotion",
					);
				validateGepaCandidate(
					original.content,
					job.candidate_content,
					expectedAnswers(job.dataset),
					exampleInputs(job.dataset),
				);
				const promoted = await d.promote(d.pool(), {
					...input,
					actor: actor(c),
				});
				logger.info("optimization.promoted", {
					job_id: promoted.id,
					project_id: promoted.project_id,
					prompt_slug: promoted.prompt_slug,
					result_version: promoted.result_version,
				});
				return c.json(publicJob(promoted));
			} catch (cause) {
				return error(c, cause);
			}
		},
		handleStop: async (
			c: Parameters<RouteHandler<typeof stopOptimization>>[0],
		): Promise<Response> => {
			try {
				const job = await d.stop(d.pool(), {
					project_id: (c.req.valid("query") as { project_id: string })
						.project_id,
					id: (c.req.valid("param") as { id: string }).id,
				});
				logger.info("optimization.stop_requested", { job_id: job.id });
				activeWorkers.get(job.id)?.abort();
				return c.json(publicJob(job));
			} catch (cause) {
				return error(c, cause);
			}
		},
		handleEvents: async (
			c: Parameters<RouteHandler<typeof optimizationEvents>>[0],
		): Promise<Response> => {
			try {
				const input = {
					project_id: (c.req.valid("query") as { project_id: string })
						.project_id,
					id: (c.req.valid("param") as { id: string }).id,
				};
				await d.get(d.pool(), input);
				return streamSSE(c, async (stream) => {
					let last = 0;
					try {
						while (!stream.aborted) {
							const next = nextOptimizationEvents(
								await d.events(d.pool(), input),
								last,
							);
							last = next.lastId;
							for (const event of next.events) {
								await stream.writeSSE({
									event: "status",
									id: String(event.id),
									data: JSON.stringify(event),
								});
							}
							if (next.terminal) return;
							await new Promise((resolve) => setTimeout(resolve, 500));
						}
					} catch {
						if (!stream.aborted)
							await stream.writeSSE({
								event: "error",
								data: JSON.stringify({
									code: "INTERNAL",
									message: "Optimization event stream failed",
								}),
							});
					}
				});
			} catch (cause) {
				return error(c, cause);
			}
		},
	};
}

export const {
	handleStart,
	handleGet,
	handleGetActive,
	handleGetLatest,
	handleListActivities,
	handlePromote,
	handleStop,
	handleEvents,
} = createOptimizationHandlers();
