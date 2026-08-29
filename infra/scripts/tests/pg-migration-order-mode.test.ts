import { expect, test } from "bun:test";
import {
	migrationLedgerSql,
	selectMigrationOrderMode,
} from "../pg-migration-order-mode";

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

test("reads the same public migration ledger as node-pg-migrate", () => {
	expect(migrationLedgerSql).toBe(
		"SELECT name FROM public.pgmigrations ORDER BY run_on ASC, id ASC",
	);
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
