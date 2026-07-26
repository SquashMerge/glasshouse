export const MAX_GEPA_METRIC_CALLS = 100;

export class GepaConfigurationError extends Error {}

export function allowedGepaModels(
	environment: NodeJS.ProcessEnv = process.env,
): Set<string> {
	const models = environment.GEPA_ALLOWED_MODELS?.split(",")
		.map((model) => model.trim())
		.filter(Boolean);
	if (!models?.length)
		throw new GepaConfigurationError(
			"GEPA_ALLOWED_MODELS must configure at least one model",
		);
	return new Set(models);
}

export function validateGepaConfiguration(input: {
	model_config: { task_lm: string; reflection_lm: string };
	budget: { max_metric_calls: number };
}): void {
	if (input.budget.max_metric_calls > MAX_GEPA_METRIC_CALLS)
		throw new GepaConfigurationError(
			`budget.max_metric_calls must not exceed ${MAX_GEPA_METRIC_CALLS}`,
		);
	const allowed = allowedGepaModels();
	for (const model of [
		input.model_config.task_lm,
		input.model_config.reflection_lm,
	]) {
		if (!allowed.has(model))
			throw new GepaConfigurationError(
				"model_config contains an unconfigured model",
			);
	}
}
