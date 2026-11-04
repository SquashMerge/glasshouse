import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const root = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const parse = (path: string) => load(read(path)) as any;

describe("standalone single-image release deployment", () => {
	it("keeps gRPC opt-in and loopback-only", () => {
		const release = parse("deploy/release/compose.yaml");
		const overlay = parse("deploy/release/compose.otlp-grpc.yaml");
		expect(release.services.api.environment.OTLP_GRPC_PORT).toBeUndefined();
		expect(overlay.services.api.environment).toEqual({
			OTLP_GRPC_PORT: 4317,
			OTLP_GRPC_HOST: "api",
		});
		expect(overlay.services.api.ports).toEqual([
			"127.0.0.1:${OTLP_GRPC_HOST_PORT:-4317}:4317",
		]);
	});

	it("preserves production data services, volumes, and API settings without a web image", () => {
		const production = parse("deploy/snapshot/compose.yaml");
		const release = parse("deploy/release/compose.yaml");
		expect(release.name).toBe(production.name);
		expect(Object.keys(release.services).sort()).toEqual([
			"api",
			"clickhouse",
			"postgres",
			"valkey",
		]);
		expect(release.volumes).toEqual(production.volumes);
		for (const service of ["postgres", "clickhouse", "valkey"]) {
			expect(release.services[service]).toEqual(production.services[service]);
		}
		expect(release.services.api.environment).toEqual(
			production.services.api.environment,
		);
		expect(release.services.api.ports).toEqual(production.services.api.ports);
		expect(release.services.api.depends_on).toEqual(
			production.services.api.depends_on,
		);
		expect(release.services.api.image).toContain("GLASSHOUSE_IMAGE:?");
		expect(release.services.api.build).toBeUndefined();
		for (const path of [
			"infra/clickhouse/backup.xml",
			"infra/valkey/valkey.conf",
		]) {
			expect(existsSync(resolve(root, "deploy/release", path))).toBe(true);
			expect(read(`deploy/release/${path}`)).toBe(
				read(`deploy/snapshot/${path}`),
			);
		}
	});
});
