import { expect, test } from "bun:test";
import { validateMigrationFilenames } from "../verify-pg-migration-filenames";

test("accepts only the documented historical duplicate prefixes", () => {
	expect(
		validateMigrationFilenames([
			"0019_feedback_first_pass.sql",
			"0019_organizations.sql",
			"0023_project_workspace_authorization.sql",
			"0023_prompt_optimization_metric_calls.sql",
			"0024_prompt_optimization_heldout.sql",
			"0024_workspace_role_guard_idempotency.sql",
			"0073_dataset_collaborative_lifecycle_governance.sql",
		]),
	).toEqual([]);
});

test("rejects a newly introduced duplicate migration prefix", () => {
	expect(
		validateMigrationFilenames([
			"0074_first_change.sql",
			"0074_second_change.sql",
		]),
	).toEqual([
		"Duplicate PostgreSQL migration prefix 0074: 0074_first_change.sql, 0074_second_change.sql",
	]);
});

test("rejects filenames that the PostgreSQL runner would not treat as migrations", () => {
	expect(validateMigrationFilenames(["0074-invalid.sql"])).toEqual([
		"Invalid PostgreSQL migration filename: 0074-invalid.sql",
	]);
});
