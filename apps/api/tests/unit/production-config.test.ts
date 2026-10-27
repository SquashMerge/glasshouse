import { describe, expect, it } from "bun:test";
import { assertProductionConfiguration } from "../../src/lib/production-config";

const validEnvironment = {
	NODE_ENV: "production",
	POSTGRES_PASSWORD: "postgres-production-secret-2026",
	CLICKHOUSE_PASSWORD: "clickhouse-production-secret-2026",
	VALKEY_PASSWORD: "valkey-production-secret-2026",
	UI_PASSWORD: "ui-production-secret-2026",
	GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: "break-glass-production-owner-2026",
	GLASSHOUSE_PUBLIC_ORIGIN: "https://glasshouse.example.com",
};

describe("production configuration", () => {
	it("accepts an explicitly production, HTTPS configuration", () => {
		expect(() => assertProductionConfiguration(validEnvironment)).not.toThrow();
	});

	for (const [name, value] of [
		["NODE_ENV", "development"],
		["POSTGRES_PASSWORD", "CHANGE_ME"],
		["GLASSHOUSE_PUBLIC_ORIGIN", "http://glasshouse.example.com"],
		["GEPA_WORKER_MODE", "cli"],
		["GLASSHOUSE_ALLOW_DEV_LLM_IN_PRODUCTION", "true"],
	] as const) {
		it(`rejects ${name}=${value}`, () => {
			expect(() =>
				assertProductionConfiguration({ ...validEnvironment, [name]: value }),
			).toThrow();
		});
	}
});
