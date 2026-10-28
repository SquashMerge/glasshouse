import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const composeRoot = resolve(import.meta.dir, "../../../..");

function renderComposeConfig(
	overrides: Record<string, string> = {},
	composeFile = "infra/compose.yaml",
) {
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
			composeFile,
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
			{
				logging?: { driver?: string; options?: Record<string, string> };
				environment?: Record<string, string>;
			}
		>;
	};
}

function expectSourceLogSettings(compose: string, services: string[]) {
	for (const service of services) {
		const header = `  ${service}:\n`;
		const start = compose.indexOf(header);
		expect(start).toBeGreaterThanOrEqual(0);
		const bodyStart = start + header.length;
		const body = compose.slice(bodyStart);
		const nextService = /\n  [a-z][a-z0-9_-]*:\n/.exec(body);
		const serviceBlock = compose.slice(
			start,
			nextService ? bodyStart + nextService.index : undefined,
		);
		expect(serviceBlock).toContain("driver: ${DOCKER_LOG_DRIVER:-local}");
		expect(serviceBlock).toContain("max-size: ${DOCKER_LOG_MAX_SIZE:-10m}");
		expect(serviceBlock).toContain("max-file: ${DOCKER_LOG_MAX_FILE:-3}");
	}
}

describe("Compose API database configuration", () => {
	it("keeps production services private and requires production configuration", () => {
		const compose = readFileSync(
			resolve(import.meta.dir, "../../../../infra/compose.production.yaml"),
			"utf8",
		);
		expect(compose).toContain("NODE_ENV: production");
		expect(compose).toContain('"127.0.0.1:${API_PORT:-3000}:3000"');
		expect(compose).toContain('"127.0.0.1:${WEB_PORT:-5173}:5173"');
		for (const service of ["postgres", "clickhouse", "valkey"]) {
			const block = compose.slice(compose.indexOf(`  ${service}:`));
			expect(block.slice(0, block.indexOf("\n  ", 4))).not.toContain("ports:");
		}
		expect(compose).not.toContain("GEPA_WORKER_MODE: cli");
	});

	it("pins the production API container to the production startup mode", () => {
		const compose = readFileSync(
			resolve(import.meta.dir, "../../../../infra/compose.production.yaml"),
			"utf8",
		);
		const apiEnvironment = compose.slice(
			compose.indexOf("  api:\n"),
			compose.indexOf("  web:\n"),
		);

		expect(apiEnvironment).toContain("NODE_ENV: production");
		expect(apiEnvironment).not.toContain("NODE_ENV: ${");
	});

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

	it("renders the production PostgreSQL URL with its configured password", () => {
		const compose = readFileSync(
			resolve(import.meta.dir, "../../../../infra/compose.production.yaml"),
			"utf8",
		);
		const apiEnvironment = compose.slice(
			compose.indexOf("  api:"),
			compose.indexOf("  web:"),
		);
		const expectedExpression = [
			"DATABASE_URL: postgres://",
			"${POSTGRES_USER}:",
			"${POSTGRES_PASSWORD}@postgres:5432/",
			"${POSTGRES_DB:-glasshouse}",
		].join("");

		expect(apiEnvironment).toContain(expectedExpression);
		expect(apiEnvironment).not.toContain(":***@");

		const password = "production-compose-test-password";
		const config = renderComposeConfig(
			{
				NODE_ENV: "production",
				POSTGRES_USER: "production_compose_test",
				POSTGRES_PASSWORD: password,
				POSTGRES_DB: "production_compose_test",
				CLICKHOUSE_USER: "production_compose_test",
				CLICKHOUSE_PASSWORD: "production-compose-test-clickhouse-password",
				VALKEY_PASSWORD: "production-compose-test-valkey-password",
				UI_USERNAME: "production_compose_test",
				UI_PASSWORD: "production-compose-test-ui-password",
				GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: "production_compose_test_owner",
				GLASSHOUSE_PUBLIC_ORIGIN: "https://glasshouse.example.test",
				GEPA_ALLOWED_MODELS: "openai/gpt-4o-mini",
			},
			"infra/compose.production.yaml",
		);
		if (config) {
			expect(config.services.api?.environment?.DATABASE_URL).toBe(
				`postgres://production_compose_test:${password}@postgres:5432/production_compose_test`,
			);
		}
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
			expectSourceLogSettings(compose, [
				"postgres",
				"clickhouse",
				"valkey",
				"api",
				"web",
			]);
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
			expectSourceLogSettings(compose, [
				"postgres",
				"clickhouse",
				"valkey",
				"api",
				"web",
			]);
			return;
		}

		for (const service of ["postgres", "clickhouse", "valkey", "api", "web"]) {
			expect(config.services[service]?.logging).toEqual({
				driver: "json-file",
				options: { "max-file": "7", "max-size": "25m" },
			});
		}
	});

	it("renders bounded default Docker log rotation for dependency services", () => {
		const config = renderComposeConfig({}, "infra/compose.deps.yaml");
		if (!config) {
			const compose = readFileSync(
				resolve(composeRoot, "infra/compose.deps.yaml"),
				"utf8",
			);
			expectSourceLogSettings(compose, ["postgres", "clickhouse", "valkey"]);
			return;
		}

		for (const service of ["postgres", "clickhouse", "valkey"]) {
			expect(config.services[service]?.logging).toEqual({
				driver: "local",
				options: { "max-file": "3", "max-size": "10m" },
			});
		}
	});

	it("renders dependency-service operator-selected driver and rotation settings", () => {
		const config = renderComposeConfig(
			{
				DOCKER_LOG_DRIVER: "json-file",
				DOCKER_LOG_MAX_SIZE: "25m",
				DOCKER_LOG_MAX_FILE: "7",
			},
			"infra/compose.deps.yaml",
		);
		if (!config) {
			const compose = readFileSync(
				resolve(composeRoot, "infra/compose.deps.yaml"),
				"utf8",
			);
			expectSourceLogSettings(compose, ["postgres", "clickhouse", "valkey"]);
			return;
		}

		for (const service of ["postgres", "clickhouse", "valkey"]) {
			expect(config.services[service]?.logging).toEqual({
				driver: "json-file",
				options: { "max-file": "7", "max-size": "25m" },
			});
		}
	});
});
