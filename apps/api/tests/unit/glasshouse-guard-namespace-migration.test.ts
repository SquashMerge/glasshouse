import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0107_glasshouse_guard_namespace.sql",
	),
	"utf8",
);
const migrationHarness = readFileSync(
	resolve(import.meta.dir, "../../../../infra/scripts/test-db-migrations.sh"),
	"utf8",
);
const migrationAssertions = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0107.assert.sql",
	),
	"utf8",
);

test("renames live authorization markers without weakening guard behavior", () => {
	for (const functionName of [
		"project_deletion_is_authorized",
		"dataset_retention_is_authorized",
		"prevent_dataset_snapshot_mutation",
		"prevent_dataset_lifecycle_audit_mutation",
		"prevent_dataset_tombstone_mutation",
		"prevent_evaluation_run_input_mutation",
	]) {
		expect(migration).toContain(`FUNCTION ${functionName}`);
	}

	for (const marker of [
		"glasshouse.project_deletion_id",
		"glasshouse.dataset_retention_run_id",
		"glasshouse.dataset_retention_owner_token",
		"glasshouse.evaluation_run_admission_run_id",
	]) {
		expect(migration).toContain(marker);
	}

	expect(migration).toContain("AND status = 'running'");
	expect(migration).toContain("AND lease_expires_at >= now()");
	expect(migration).toContain(
		"evaluation run inputs can only be admitted once",
	);
});

test("runs live PostgreSQL assertions for matching, mismatched, and expired contexts", () => {
	expect(migrationHarness).toContain("test-db-migrations-0107.assert.sql");
	for (const assertion of [
		"mismatched retention owner token",
		"cross-project retention context",
		"matching active retention context",
		"expired retention lease",
		"project deletion marker did not remain project-scoped",
		"ROLLBACK;",
	]) {
		expect(migrationAssertions).toContain(assertion);
	}
});
