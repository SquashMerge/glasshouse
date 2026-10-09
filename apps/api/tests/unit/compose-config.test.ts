import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
});
