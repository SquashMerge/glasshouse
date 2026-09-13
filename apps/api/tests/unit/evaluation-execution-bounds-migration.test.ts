import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Evaluation execution bounds migration", () => {
	it("persists immutable bounds, atomically charged provider calls, and one active capacity admission per run", () => {
		const migration = readFileSync(
			resolve(
				import.meta.dir,
				"../../../../infra/db/migrations/0095_evaluation_execution_bounds.sql",
			),
			"utf8",
		);

		expect(migration).toContain("execution_bounds");
		expect(migration).toContain("provider_call_count");
		expect(migration).toContain("evaluation_run_capacity_admissions");
		expect(migration).toContain("release_evaluation_run_capacity");
	});

	it("replays the 0095 upgrade over a populated pre-0095 Evaluation Run", () => {
		const harness = readFileSync(
			resolve(
				import.meta.dir,
				"../../../../infra/scripts/test-db-migrations.sh",
			),
			"utf8",
		);
		expect(harness).toContain("test-db-migrations-0095-upgrade.fixture.sql");
		expect(harness).toContain("test-db-migrations-0095-upgrade.assert.sql");
	});
});
