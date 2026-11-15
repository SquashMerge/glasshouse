import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as yaml from "js-yaml";
import { valkey } from "../../../apps/api/src/db/valkey";

const root = new URL("../../../", import.meta.url);
describe("release deployment bundle", () => {
	test("passes an arbitrary Valkey password to the real client without embedding it in a URL", () => {
		const config = yaml.load(
			readFileSync(new URL("deploy/release/compose.yaml", root), "utf8"),
		) as { services: { app: { environment: Record<string, string> } } };
		const mapping = config.services.app.environment;
		const password = "synthetic-#?/%@:$+ secret";
		const previous = { ...process.env };
		try {
			for (const key of [
				"VALKEY_URL",
				"VALKEY_HOST",
				"VALKEY_PORT",
				"VALKEY_PASSWORD",
			])
				delete process.env[key];
			for (const key of [
				"VALKEY_URL",
				"VALKEY_HOST",
				"VALKEY_PORT",
				"VALKEY_PASSWORD",
			]) {
				const value = mapping[key];
				if (value !== undefined)
					process.env[key] = String(value).replace(
						/\$\{VALKEY_PASSWORD:\?[^}]+\}/g,
						() => password,
					);
			}
			const client = valkey();
			expect(client.options.host).toBe("valkey");
			expect(client.options.password).toBe(password);
			expect(process.env.VALKEY_URL).toBeUndefined();
		} finally {
			for (const key of [
				"VALKEY_URL",
				"VALKEY_HOST",
				"VALKEY_PORT",
				"VALKEY_PASSWORD",
			]) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
		}
	});
	test("defines one application image and external data services without application builds", () => {
		const file = readFileSync(
			new URL("deploy/release/compose.yaml", root),
			"utf8",
		);
		const config = yaml.load(file) as {
			services: Record<string, { image?: string; build?: unknown }>;
		};
		expect(Object.keys(config.services).sort()).toEqual([
			"app",
			"clickhouse",
			"postgres",
			"valkey",
		]);
		expect(config.services.app.image).toContain("GLASSHOUSE_IMAGE");
		for (const service of Object.values(config.services))
			expect(service.build).toBeUndefined();
	});
	test("fresh releases select local bootstrap for browser onboarding", () => {
		const compose = readFileSync(
			new URL("deploy/release/compose.yaml", root),
			"utf8",
		);
		expect(compose).toContain("${GLASSHOUSE_AUTH_BOOTSTRAP_MODE:-local}");
	});
	test("the single image includes the built web app and runs the existing API startup", () => {
		const dockerfile = readFileSync(
			new URL("deploy/release/Dockerfile", root),
			"utf8",
		);
		expect(dockerfile).toContain('bun --filter "@glasshouse/web" build');
		expect(dockerfile).toContain("ENV GLASSHOUSE_WEB_DIST=/app/apps/web/dist");
		expect(dockerfile).toContain("cd apps/api && bun run start");
	});
});
