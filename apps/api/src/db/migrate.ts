import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PG_MIGRATE_LOCK_ID, runner } from "node-pg-migrate";
import { Client } from "pg";

const nodePgMigrateLockId = PG_MIGRATE_LOCK_ID;

function sortMigrationNames(names: readonly string[]): string[] {
	return [...names].sort((left, right) => {
		const leftPrefix = Number(left.match(/^(\d+)/)?.[1]);
		const rightPrefix = Number(right.match(/^(\d+)/)?.[1]);
		return leftPrefix - rightPrefix || left.localeCompare(right);
	});
}

async function checkMigrationOrder(
	client: Client,
	migrationDirectory: string,
): Promise<boolean> {
	const migrationTable = await client.query<{ table_name: string | null }>(
		"SELECT to_regclass('public.pgmigrations') AS table_name",
	);
	if (!migrationTable.rows[0]?.table_name) return true;

	const runMigrations = await client.query<{ name: string }>(
		"SELECT name FROM public.pgmigrations ORDER BY run_on ASC, id ASC",
	);
	const migrationNames = sortMigrationNames(
		readdirSync(migrationDirectory)
			.filter((filename) => filename.endsWith(".sql"))
			.map((filename) => filename.slice(0, -".sql".length)),
	);
	const runNames = runMigrations.rows.map((migration) => migration.name);
	if (runNames.every((name, index) => name === migrationNames[index])) {
		return true;
	}

	const legacyNames = [...migrationNames];
	const projectIndex = legacyNames.indexOf(
		"0023_project_workspace_authorization",
	);
	const promptIndex = legacyNames.indexOf(
		"0023_prompt_optimization_metric_calls",
	);
	if (
		projectIndex === -1 ||
		promptIndex === -1 ||
		projectIndex >= promptIndex
	) {
		return true;
	}
	const projectMigration = legacyNames[projectIndex];
	legacyNames[projectIndex] = legacyNames[promptIndex]!;
	legacyNames[promptIndex] = projectMigration!;
	return !(
		runNames.every((name, index) => name === legacyNames[index]) &&
		runNames.includes("0023_prompt_optimization_metric_calls")
	);
}

export async function migrate(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (!env.DATABASE_URL) {
		throw new Error("DATABASE_URL is required to run PostgreSQL migrations.");
	}

	const client = new Client({ connectionString: env.DATABASE_URL });
	const migrationDirectory = resolve(
		import.meta.dir,
		"../../../../infra/db/migrations",
	);
	let locked = false;
	await client.connect();
	try {
		await client.query("SELECT pg_advisory_lock($1)", [nodePgMigrateLockId]);
		locked = true;
		const checkOrder = await checkMigrationOrder(client, migrationDirectory);
		await runner({
			dbClient: client,
			dir: migrationDirectory,
			direction: "up",
			migrationsTable: "pgmigrations",
			migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
			checkOrder,
			advisoryLockMode: "wait",
			lockValue: nodePgMigrateLockId,
			singleTransaction: true,
		});
	} finally {
		try {
			if (locked) {
				await client.query("SELECT pg_advisory_unlock($1)", [
					nodePgMigrateLockId,
				]);
			}
		} finally {
			await client.end();
		}
	}
}

if (import.meta.main) await migrate();
