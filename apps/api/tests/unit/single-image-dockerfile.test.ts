import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("single image candidate includes the web build and existing API runtime", () => {
	const dockerfile = readFileSync(
		resolve(import.meta.dir, "../../Dockerfile.single"),
		"utf8",
	);
	expect(dockerfile).toContain('bun --filter "@glasshouse/web" build');
	expect(dockerfile).toContain('bun --filter "@glasshouse/api" build');
	expect(dockerfile).toContain("/app/apps/web/dist ./apps/web/dist");
	expect(dockerfile).toContain("ENV GLASSHOUSE_WEB_ROOT=/app/apps/web/dist");
	expect(dockerfile).toContain("bun run start");
	expect(dockerfile).toContain("worker/requirements.lock");
	expect(dockerfile).toContain("infra/db/migrations");
	expect(dockerfile).toContain("infra/db/clickhouse");
});
