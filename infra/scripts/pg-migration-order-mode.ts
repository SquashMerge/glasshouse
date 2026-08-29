import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export type MigrationOrderMode = "strict" | "legacy-0023-inversion";

const projectWorkspaceMigration = "0023_project_workspace_authorization";
const promptMetricCallsMigration = "0023_prompt_optimization_metric_calls";

export function sortMigrationNames(names: readonly string[]): string[] {
	return [...names].sort((left, right) => {
		const leftPrefix = Number(left.match(/^(\d+)/)?.[1]);
		const rightPrefix = Number(right.match(/^(\d+)/)?.[1]);
		return leftPrefix - rightPrefix || left.localeCompare(right);
	});
}

function startsWith(
	actual: readonly string[],
	expected: readonly string[],
): boolean {
	return actual.every((name, index) => name === expected[index]);
}

export function selectMigrationOrderMode(
	migrationNames: readonly string[],
	runNames: readonly string[],
): MigrationOrderMode {
	const orderedMigrationNames = sortMigrationNames(migrationNames);
	if (startsWith(runNames, orderedMigrationNames)) return "strict";

	const projectIndex = orderedMigrationNames.indexOf(projectWorkspaceMigration);
	const promptIndex = orderedMigrationNames.indexOf(promptMetricCallsMigration);
	if (
		projectIndex === -1 ||
		promptIndex === -1 ||
		projectIndex >= promptIndex
	) {
		return "strict";
	}

	const legacyOrder = [...orderedMigrationNames];
	[legacyOrder[projectIndex], legacyOrder[promptIndex]] = [
		legacyOrder[promptIndex],
		legacyOrder[projectIndex],
	];
	return startsWith(runNames, legacyOrder) &&
		runNames.includes(promptMetricCallsMigration)
		? "legacy-0023-inversion"
		: "strict";
}

export async function detectMigrationOrderMode(
	databaseUrl: string | undefined,
	migrationDirectory: string,
): Promise<MigrationOrderMode> {
	if (!databaseUrl) {
		throw new Error(
			"DATABASE_URL is required to inspect PostgreSQL migration order.",
		);
	}

	const { Client } = await import("../../apps/api/node_modules/pg");
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const migrationTable = await client.query<{ table_name: string | null }>(
			"SELECT to_regclass('public.pgmigrations') AS table_name",
		);
		if (!migrationTable.rows[0]?.table_name) return "strict";

		const runMigrations = await client.query<{ name: string }>(
			"SELECT name FROM pgmigrations ORDER BY run_on ASC, id ASC",
		);
		return selectMigrationOrderMode(
			readdirSync(migrationDirectory)
				.filter((filename) => filename.endsWith(".sql"))
				.map((filename) => filename.slice(0, -".sql".length)),
			runMigrations.rows.map((migration) => migration.name),
		);
	} finally {
		await client.end();
	}
}

if (import.meta.main) {
	const migrationDirectory = resolve(import.meta.dir, "../db/migrations");
	console.log(
		await detectMigrationOrderMode(
			process.env.DATABASE_URL,
			migrationDirectory,
		),
	);
}
