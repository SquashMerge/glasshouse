export type EvaluationExecutionBounds = {
	max_active_runs_per_project: number;
	max_active_runs_per_actor: number;
	max_requested_sample_size: number;
	max_provider_calls: number;
};

export type ResolvedEvaluationExecutionPolicy = {
	provider: "openai" | "codex_cli";
	model: string;
	bounds: EvaluationExecutionBounds;
};

export class EvaluationExecutionPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvaluationExecutionPolicyError";
	}
}

type Environment = Record<string, string | undefined>;

function boundedInteger(
	value: string | undefined,
	fallback: number,
	maximum: number,
): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
		? parsed
		: fallback;
}

function allowedModels(environment: Environment): Set<string> {
	const configured =
		environment.EVALUATION_ALLOWED_MODELS ?? "openai/gpt-4o-mini";
	const models = configured
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (
		models.length === 0 ||
		models.some(
			(value) =>
				!/^(?:openai|codex_cli)\/[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(
					value,
				),
		)
	)
		throw new EvaluationExecutionPolicyError(
			"Evaluation provider/model policy is not configured safely",
		);
	return new Set(models);
}

export function resolveEvaluationExecutionPolicy(
	target: { provider?: unknown; model?: unknown },
	requestedSampleSize: number,
	environment: Environment = process.env,
): ResolvedEvaluationExecutionPolicy {
	const provider =
		typeof target.provider === "string"
			? target.provider
			: (environment.ASTRAEA_EVAL_LLM_PROVIDER ?? "openai");
	const model =
		typeof target.model === "string" && target.model.trim()
			? target.model.trim()
			: (environment.OPENAI_MODEL ?? "gpt-4o-mini");
	if (provider !== "openai" && provider !== "codex_cli")
		throw new EvaluationExecutionPolicyError(
			"Evaluation provider/model is not approved",
		);
	if (!allowedModels(environment).has(`${provider}/${model}`))
		throw new EvaluationExecutionPolicyError(
			"Evaluation provider/model is not approved",
		);
	const bounds = {
		max_active_runs_per_project: boundedInteger(
			environment.EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT,
			4,
			32,
		),
		max_active_runs_per_actor: boundedInteger(
			environment.EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR,
			2,
			32,
		),
		max_requested_sample_size: boundedInteger(
			environment.EVALUATION_MAX_REQUESTED_SAMPLE_SIZE_PER_RUN,
			100,
			10_000,
		),
		max_provider_calls: boundedInteger(
			environment.EVALUATION_MAX_PROVIDER_CALLS_PER_RUN,
			100,
			10_000,
		),
	};
	if (
		!Number.isSafeInteger(requestedSampleSize) ||
		requestedSampleSize < 1 ||
		requestedSampleSize > bounds.max_requested_sample_size ||
		requestedSampleSize > bounds.max_provider_calls
	)
		throw new EvaluationExecutionPolicyError(
			"Evaluation exceeds the operator requested sample-size cap or provider-call budget",
		);
	return { provider, model, bounds };
}
