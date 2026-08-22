import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0072_dataset_version_execution_binding.sql",
	),
	"utf8",
);
const migrationHarness = readFileSync(
	resolve(import.meta.dir, "../../../../infra/scripts/test-db-migrations.sh"),
	"utf8",
);
const fixture = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0072.fixture.sql",
	),
	"utf8",
);
const preMigrationAssertion = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0072.pre.assert.sql",
	),
	"utf8",
);
const assertion = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0072.assert.sql",
	),
	"utf8",
);

test("0072 revokes legacy task admissions before terminalizing legacy executions", () => {
	const cancelAdmissions = migration.indexOf(
		"UPDATE execution_admissions\nSET status = 'cancelled'",
	);
	const cancelTasks = migration.indexOf("UPDATE experiment_tasks");
	const cancelExperiments = migration.indexOf(
		"UPDATE experiments\nSET status = 'cancelled'",
	);

	expect(cancelAdmissions).toBeGreaterThan(-1);
	expect(cancelAdmissions).toBeLessThan(cancelTasks);
	expect(cancelAdmissions).toBeLessThan(cancelExperiments);
	expect(migration).toContain("work_kind = 'experiment_task'");
	const legacyItemInsert = fixture.indexOf("INSERT INTO dataset_items");
	const experimentInsert = fixture.indexOf("INSERT INTO experiments");
	expect(legacyItemInsert).toBeGreaterThan(-1);
	expect(legacyItemInsert).toBeLessThan(experimentInsert);
	expect(fixture).toContain("execution_admissions");
	expect(preMigrationAssertion).toContain("legacy dataset item");
	expect(preMigrationAssertion).toContain("historical trigger");
	expect(preMigrationAssertion).toContain("active admission");
	expect(assertion).toContain("execution_admissions");
	expect(migrationHarness).toContain("UPGRADE_0072_DATABASE");
	expect(migrationHarness).toContain("test-db-migrations-0072.pre.assert.sql");
});
