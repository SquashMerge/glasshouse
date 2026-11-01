import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const root = resolve(import.meta.dir, "../../..");
const bundle = resolve(root, "deploy/snapshot");

describe("checkout-free snapshot Compose bundle", () => {
	it("runs its contract checks in the infrastructure security CI suite", () => {
		const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
		expect(pkg.scripts["test:infra-security"]).toContain(
			"infra/scripts/tests/image-compose.test.ts",
		);
	});

	it("requires the actual image integration job without package write permissions", () => {
		const ci = load(
			readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"),
		) as any;
		const job = ci.jobs["image-compose-integration"];
		expect(job).toBeDefined();
		expect(job.permissions).toEqual({ contents: "read" });
		expect(
			job.steps.some((step: any) =>
				String(step.run).includes("test-image-compose-integration.sh"),
			),
		).toBe(true);
	});

	it("routes proxy web requests using a Vite-accepted host", () => {
		const proxy = readFileSync(
			resolve(root, "infra/scripts/image-integration/proxy.conf"),
			"utf8",
		);
		expect(proxy).toContain("proxy_set_header Host localhost");
	});

	it("preserves production topology while replacing builds with required image references", () => {
		const manifest = resolve(bundle, "compose.yaml");
		expect(existsSync(manifest)).toBe(true);
		if (!existsSync(manifest)) return;
		const production = load(
			readFileSync(resolve(root, "infra/compose.production.yaml"), "utf8"),
		) as any;
		const images = load(readFileSync(manifest, "utf8")) as any;
		for (const name of ["api", "web"]) {
			expect(images.services[name].build).toBeUndefined();
			expect(images.services[name].image).toBe(
				`\${GLASSHOUSE_${name.toUpperCase()}_IMAGE:?GLASSHOUSE_${name.toUpperCase()}_IMAGE is required}`,
			);
			delete production.services[name].build;
			delete images.services[name].image;
		}
		expect(images).toEqual(production);
	});

	it("bounds logs for every production service", () => {
		for (const path of [
			"infra/compose.production.yaml",
			"deploy/snapshot/compose.yaml",
		]) {
			const manifest = load(readFileSync(resolve(root, path), "utf8")) as any;
			for (const service of Object.values(manifest.services) as any[]) {
				expect(service.logging?.driver).toBe("${DOCKER_LOG_DRIVER:-local}");
				expect(service.logging?.options?.["max-size"]).toBe(
					"${DOCKER_LOG_MAX_SIZE:-10m}",
				);
				expect(service.logging?.options?.["max-file"]).toBe(
					"${DOCKER_LOG_MAX_FILE:-3}",
				);
			}
		}
	});

	it("includes the production configuration template", () => {
		const template = resolve(bundle, "production.env.example");
		expect(existsSync(template)).toBe(true);
		if (existsSync(template)) {
			expect(readFileSync(template)).toEqual(
				readFileSync(resolve(root, "infra/production.env.example")),
			);
		}
	});

	it("includes exact production datastore mount configuration", () => {
		for (const file of [
			"infra/clickhouse/backup.xml",
			"infra/valkey/valkey.conf",
		]) {
			expect(existsSync(resolve(bundle, file))).toBe(true);
			if (existsSync(resolve(bundle, file))) {
				expect(readFileSync(resolve(bundle, file))).toEqual(
					readFileSync(resolve(root, file)),
				);
			}
		}
	});
});
