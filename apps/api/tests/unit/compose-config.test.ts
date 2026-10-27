import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const composeRoot = resolve(import.meta.dir, "../../../..");

function renderComposeConfig(overrides: Record<string, string> = {}) {
	const environment = {
		...process.env,
		POSTGRES_USER: "compose-test",
		POSTGRES_PASSWORD: "compose-test-password",
		CLICKHOUSE_USER: "compose-test",
		CLICKHOUSE_PASSWORD: "compose-test-password",
		VALKEY_PASSWORD: "compose-test-password",
		UI_USERNAME: "compose-test",
		UI_PASSWORD: "compose-test-password",
		GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: "compose-test",
		GEPA_ALLOWED_MODELS: "openai/gpt-4o-mini",
	};
	delete environment.DOCKER_LOG_DRIVER;
	delete environment.DOCKER_LOG_MAX_SIZE;
	delete environment.DOCKER_LOG_MAX_FILE;
	Object.assign(environment, overrides);

	const result = spawnSync(
		"docker",
		[
			"compose",
			"--project-directory",
			composeRoot,
			"--env-file",
			"/dev/null",
			"-f",
			"infra/compose.yaml",
			"config",
			"--format",
			"json",
		],
		{
			cwd: composeRoot,
			encoding: "utf8",
			env: environment,
		},
	);

	if (result.error?.code === "ENOENT") {
		return undefined;
	}
	if (result.status !== 0) {
		throw new Error(`docker compose config failed: ${result.stderr}`);
	}
	return JSON.parse(result.stdout) as {
		services: Record<
			string,
			{ logging?: { driver?: string; options?: Record<string, string> } }
		>;
	};
}

describe("Compose API database configuration", () => {
	it("provides a real migration URL and component variables without a placeholder password", () => {
		const compose = readFileSync(
			resolve(import.meta.dir, "../../../../infra/compose.yaml"),
			"utf8",
		);
		const apiEnvironment = compose.slice(
			compose.indexOf("  api:\n"),
			compose.indexOf("  web:\n"),
		);

		expect(apiEnvironment).toContain(
			"DATABASE_URL: postgres://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@postgres:5432/\${POSTGRES_DB:-glasshouse}",
		);
		expect(apiEnvironment).not.toContain(":***@");
		expect(apiEnvironment).toContain("POSTGRES_HOST: postgres");
		expect(apiEnvironment).toContain(
			"POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in infra/.env}",
		);
	});

	it("passes runtime safety and observability controls into the API container", () => {
		const compose = readFileSync(
			resolve(import.meta.dir, "../../../../infra/compose.yaml"),
			"utf8",
		);
		const apiEnvironment = compose.slice(
			compose.indexOf("  api:\n"),
			compose.indexOf("  web:\n"),
		);

		expect(apiEnvironment).toContain("LOG_LEVEL: ${LOG_LEVEL:-info}");
		expect(apiEnvironment).toContain(
			"GLASSHOUSE_REDACT_INPUT: ${GLASSHOUSE_REDACT_INPUT:-false}",
		);
		expect(apiEnvironment).toContain(
			"GLASSHOUSE_REDACT_KEYS: ${GLASSHOUSE_REDACT_KEYS:-}",
		);
		expect(apiEnvironment).toContain(
			"API_MAX_BODY_BYTES: ${API_MAX_BODY_BYTES:-1048576}",
		);
	});

	it("preserves physical data volume IDs across the Glasshouse compose rename", () => {
		const fullCompose = readFileSync(
			resolve(import.meta.dir, "../../../../infra/compose.yaml"),
			"utf8",
		);
		const dependenciesCompose = readFileSync(
			resolve(import.meta.dir, "../../../../infra/compose.deps.yaml"),
			"utf8",
		);
		const fullVolumes = fullCompose.slice(fullCompose.lastIndexOf("volumes:"));
		const dependencyVolumes = dependenciesCompose.slice(
			dependenciesCompose.lastIndexOf("volumes:"),
		);

		for (const [logical, physical] of [
			["glasshouse_pg_data", "astraea_astraea_pg_data"],
			["glasshouse_ch_data", "astraea_astraea_ch_data"],
			["glasshouse_valkey_data", "astraea_astraea_valkey_data"],
		] as const) {
			expect(fullVolumes).toContain(`${logical}:\n    name: ${physical}`);
		}
		for (const [logical, physical] of [
			["glasshouse_pg_data", "astraea-deps_astraea_pg_data"],
			["glasshouse_ch_data", "astraea-deps_astraea_ch_data"],
			["glasshouse_valkey_data", "astraea-deps_astraea_valkey_data"],
		] as const) {
			expect(dependencyVolumes).toContain(`${logical}:\n    name: ${physical}`);
		}
	});

	it("renders bounded default Docker log rotation for every full-stack service", () => {
		const config = renderComposeConfig();
		if (!config) {
			const compose = readFileSync(
				resolve(composeRoot, "infra/compose.yaml"),
				"utf8",
			);
			expect(
				compose.match(
					/driver: \$\{DOCKER_LOG_DRIVER:-local\}\n      options:\n        max-size: \$\{DOCKER_LOG_MAX_SIZE:-10m\}\n        max-file: \$\{DOCKER_LOG_MAX_FILE:-3\}/g,
				)?.length,
			).toBe(5);
			return;
		}

		for (const service of ["postgres", "clickhouse", "valkey", "api", "web"]) {
			expect(config.services[service]?.logging).toEqual({
				driver: "local",
				options: { "max-file": "3", "max-size": "10m" },
			});
		}
	});

	it("renders operator-selected driver and rotation settings", () => {
		const config = renderComposeConfig({
			DOCKER_LOG_DRIVER: "json-file",
			DOCKER_LOG_MAX_SIZE: "25m",
			DOCKER_LOG_MAX_FILE: "7",
		});
		if (!config) {
			const compose = readFileSync(
				resolve(composeRoot, "infra/compose.yaml"),
				"utf8",
			);
			expect(compose).toContain("driver: ${DOCKER_LOG_DRIVER:-local}");
			expect(compose).toContain("max-size: ${DOCKER_LOG_MAX_SIZE:-10m}");
			expect(compose).toContain("max-file: ${DOCKER_LOG_MAX_FILE:-3}");
			return;
		}

		for (const service of ["postgres", "clickhouse", "valkey", "api", "web"]) {
			expect(config.services[service]?.logging).toEqual({
				driver: "json-file",
				options: { "max-file": "7", "max-size": "25m" },
			});
		}
	});
});
