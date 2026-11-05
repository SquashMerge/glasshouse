import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

const root = new URL("../../../", import.meta.url);
const workflow = load(
	readFileSync(new URL(".github/workflows/ci.yml", root), "utf8"),
) as {
	jobs: Record<
		string,
		{
			steps: { run?: string }[];
			strategy?: { matrix: { include: { check: string; command: string }[] } };
		}
	>;
};

test("CI requires the disposable OTLP harness and its safety regressions", () => {
	expect(workflow.jobs["otlp-sdk-integration"].steps).toContainEqual({
		name: "Exercise SDK exporters, deep public ingestion, and real shutdown signals against disposable stores",
		run: "bash infra/scripts/test-otlp-sdk-integration.sh",
	});
	const checks = workflow.jobs.checks.strategy?.matrix.include ?? [];
	expect(checks.find((check) => check.check === "test")?.command).toBe(
		"bun run test",
	);
	expect(readFileSync(new URL("package.json", root), "utf8")).toContain(
		"infra/scripts/tests/verify-otlp-ci.test.ts",
	);
});

test("OTLP runner uses the existing build stage and private fixture without URL overrides", () => {
	const fixture = load(
		readFileSync(
			new URL(".github/compose.otlp-sdk-integration.yaml", root),
			"utf8",
		),
	) as { services: Record<string, Record<string, unknown>> };
	const runner = fixture.services["otlp-tests"];
	expect(runner).toBeDefined();
	expect(runner.build).toEqual({
		context: ".",
		dockerfile: "apps/api/Dockerfile",
		target: "build",
	});
	for (const key of ["environment", "env_file", "volumes", "ports", "networks"])
		expect(runner[key]).toBeUndefined();
});
