import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { resolveEvaluationExecutionPolicy } from "../../../apps/api/src/lib/evaluation-execution-policy";
import { assertProductionConfiguration } from "../../../apps/api/src/lib/production-config";

const root = resolve(import.meta.dir, "../../..");
type EnvironmentMapping = Record<string, string | number | boolean>;
const compose = load(
	readFileSync(resolve(root, "infra/compose.production.yaml"), "utf8"),
) as { services: { api: { environment: EnvironmentMapping } } };
const syntheticEnvironment = {
	POSTGRES_USER: "glasshouse_test",
	POSTGRES_PASSWORD: "synthetic-postgres-4f61cba90d",
	POSTGRES_DB: "glasshouse_test",
	CLICKHOUSE_USER: "glasshouse_test",
	CLICKHOUSE_PASSWORD: "synthetic-clickhouse-6c70a4ed",
	VALKEY_PASSWORD: "synthetic-valkey-8f71b2c0ad",
	UI_USERNAME: "synthetic-owner",
	UI_PASSWORD: "synthetic-ui-9b412e8cfa",
	GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: "synthetic-owner",
	GLASSHOUSE_PUBLIC_ORIGIN: "https://glasshouse.example.invalid",
	GEPA_ALLOWED_MODELS: "openai/gpt-4o-mini",
};

function renderApiEnvironment(
	overrides: Record<string, string> = {},
	mapping = compose.services.api.environment,
) {
	const variables: Record<string, string> = {
		...syntheticEnvironment,
		...overrides,
	};
	return Object.fromEntries(
		Object.entries(mapping).map(([key, value]) => [
			key,
			// Only the forms used by this mapping; full Compose rendering is a separate smoke check.
			String(value).replace(/\$\{([^{}]*)\}|\$/g, (_, expression: string) => {
				const match = /^([A-Z_][A-Z0-9_]*)(?:(:-|:\?)([^${}]*))?$/.exec(
					expression ?? "",
				);
				if (!match)
					throw new Error(`Unsupported Compose interpolation for ${key}`);
				const [, name, operator, argument] = match;
				if (variables[name]) return variables[name];
				if (operator === ":-") return argument;
				if (operator === ":?")
					throw new Error(`Missing synthetic Compose variable ${name}`);
				return "";
			}),
		]),
	);
}

describe("production Compose API environment contract", () => {
	it("satisfies startup validation and uses the same Valkey credential", () => {
		const environment = renderApiEnvironment();
		expect(() => assertProductionConfiguration(environment)).not.toThrow();
		expect(
			environment.VALKEY_PASSWORD === syntheticEnvironment.VALKEY_PASSWORD,
		).toBe(true);
		expect(URL.canParse(environment.VALKEY_URL)).toBe(true);
		expect(
			new URL(environment.VALKEY_URL).password === environment.VALKEY_PASSWORD,
		).toBe(true);
	});

	it("rejects a missing Valkey password pass-through even with an authenticated URL", () => {
		const mapping = { ...compose.services.api.environment };
		delete mapping.VALKEY_PASSWORD;
		const environment = renderApiEnvironment({}, mapping);
		expect(URL.canParse(environment.VALKEY_URL)).toBe(true);
		expect(
			new URL(environment.VALKEY_URL).password ===
				syntheticEnvironment.VALKEY_PASSWORD,
		).toBe(true);
		expect(() => assertProductionConfiguration(environment)).toThrow(
			"VALKEY_PASSWORD is required in production",
		);
	});

	it("preserves the API's default redaction and Evaluation envelope", () => {
		const environment = renderApiEnvironment();
		expect(environment.GLASSHOUSE_REDACT_INPUT).toBe("false");
		expect(environment.GLASSHOUSE_REDACT_KEYS).toBe("");
		expect(resolveEvaluationExecutionPolicy({}, 1, environment).bounds).toEqual(
			{
				max_active_runs_per_project: 4,
				max_active_runs_per_actor: 2,
				max_requested_sample_size: 100,
				max_provider_calls: 100,
			},
		);
	});

	it("preserves the API's default GEPA active-job caps", () => {
		const environment = renderApiEnvironment();
		expect(environment.GEPA_MAX_ACTIVE_JOBS_PER_PROJECT).toBe("3");
		expect(environment.GEPA_MAX_ACTIVE_JOBS_PER_REQUESTER).toBe("1");
	});

	it("forwards configured GEPA active-job cap overrides", () => {
		const overrides = {
			GEPA_MAX_ACTIVE_JOBS_PER_PROJECT: "5",
			GEPA_MAX_ACTIVE_JOBS_PER_REQUESTER: "2",
		};
		const environment = renderApiEnvironment(overrides);
		for (const [key, value] of Object.entries(overrides))
			expect(environment[key]).toBe(value);
	});

	it("forwards configured controls and enforces the rendered model and budgets", () => {
		const overrides = {
			GLASSHOUSE_REDACT_INPUT: "true",
			GLASSHOUSE_REDACT_KEYS: "authorization,api_key",
			EVALUATION_ALLOWED_MODELS: "openai/approved-model",
			EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT: "3",
			EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR: "1",
			EVALUATION_MAX_REQUESTED_SAMPLE_SIZE_PER_RUN: "8",
			EVALUATION_MAX_PROVIDER_CALLS_PER_RUN: "9",
		};
		const environment = renderApiEnvironment(overrides);
		for (const [key, value] of Object.entries(overrides))
			expect(environment[key]).toBe(value);
		const target = { provider: "openai", model: "approved-model" };
		expect(
			resolveEvaluationExecutionPolicy(target, 8, environment).bounds,
		).toEqual({
			max_active_runs_per_project: 3,
			max_active_runs_per_actor: 1,
			max_requested_sample_size: 8,
			max_provider_calls: 9,
		});
		expect(() => resolveEvaluationExecutionPolicy({}, 1, environment)).toThrow(
			"not approved",
		);
		expect(() =>
			resolveEvaluationExecutionPolicy(target, 9, environment),
		).toThrow("cap or provider-call budget");
	});

	it("retains the API's handling of invalid bounds and model policy", () => {
		const environment = renderApiEnvironment({
			EVALUATION_ALLOWED_MODELS: "invalid-model",
			EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT: "33",
			EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR: "0",
			EVALUATION_MAX_REQUESTED_SAMPLE_SIZE_PER_RUN: "NaN",
			EVALUATION_MAX_PROVIDER_CALLS_PER_RUN: "10001",
		});
		expect(() => resolveEvaluationExecutionPolicy({}, 1, environment)).toThrow(
			"not configured safely",
		);
		environment.EVALUATION_ALLOWED_MODELS = "openai/gpt-4o-mini";
		expect(resolveEvaluationExecutionPolicy({}, 1, environment).bounds).toEqual(
			{
				max_active_runs_per_project: 4,
				max_active_runs_per_actor: 2,
				max_requested_sample_size: 100,
				max_provider_calls: 100,
			},
		);
	});
});
