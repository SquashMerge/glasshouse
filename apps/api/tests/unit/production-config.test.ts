import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

	it("rejects the shipped production environment template", () => {
		const template = readFileSync(
			resolve(import.meta.dir, "../../../../infra/production.env.example"),
			"utf8",
		);
		const environment = Object.fromEntries(
			template
				.split("\n")
				.filter((line) => line && !line.startsWith("#"))
				.map((line) => {
					const separator = line.indexOf("=");
					return [line.slice(0, separator), line.slice(separator + 1)];
				}),
		);

		for (const name of [
			"POSTGRES_PASSWORD",
			"CLICKHOUSE_PASSWORD",
			"VALKEY_PASSWORD",
			"UI_PASSWORD",
		] as const) {
			expect(() =>
				assertProductionConfiguration({
					...validEnvironment,
					[name]: environment[name],
				}),
			).toThrow(`${name} must be a non-placeholder production secret`);
		}
	});

	it("rejects PostgreSQL passwords that cannot be embedded safely in DATABASE_URL", () => {
		expect(() =>
			assertProductionConfiguration({
				...validEnvironment,
				POSTGRES_PASSWORD: "postgres-production-secret/2026",
			}),
		).toThrow(
			"POSTGRES_PASSWORD must use only URL-unreserved ASCII characters",
		);
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
