import { expect, test } from "bun:test";
import { selectMigrationOrderMode } from "../pg-migration-order-mode";

const migrationNames = [
	"0022_experiment_task_ledger",
	"0023_project_workspace_authorization",
	"0023_prompt_optimization_metric_calls",
	"0024_prompt_optimization_heldout",
];

test("permits only the recorded 0023 migration inversion", () => {
	expect(
		selectMigrationOrderMode(migrationNames, [
			"0022_experiment_task_ledger",
			"0023_prompt_optimization_metric_calls",
		]),
	).toBe("legacy-0023-inversion");
	expect(
		selectMigrationOrderMode(migrationNames, [
			"0022_experiment_task_ledger",
			"0023_prompt_optimization_metric_calls",
			"0023_project_workspace_authorization",
			"0024_prompt_optimization_heldout",
		]),
	).toBe("legacy-0023-inversion");
});

test("keeps normal order enforcement for every other history", () => {
	expect(
		selectMigrationOrderMode(migrationNames, [
			"0023_prompt_optimization_metric_calls",
			"0022_experiment_task_ledger",
		]),
	).toBe("strict");
	expect(
		selectMigrationOrderMode(migrationNames, [
			"0022_experiment_task_ledger",
			"0023_project_workspace_authorization",
		]),
	).toBe("strict");
});
