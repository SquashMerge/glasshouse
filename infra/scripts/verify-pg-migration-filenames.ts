import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const legacyDuplicatePrefixes = new Map<string, readonly string[]>([
	["0019", ["0019_feedback_first_pass.sql", "0019_organizations.sql"]],
	[
		"0023",
		[
			"0023_project_workspace_authorization.sql",
			"0023_prompt_optimization_metric_calls.sql",
		],
	],
	[
		"0024",
		[
			"0024_prompt_optimization_heldout.sql",
			"0024_workspace_role_guard_idempotency.sql",
		],
	],
]);

const migrationFilenamePattern = /^(\d+)_[a-z0-9_]+\.sql$/;

export function validateMigrationFilenames(
	filenames: readonly string[],
): string[] {
	const errors: string[] = [];
	const namesByPrefix = new Map<string, string[]>();

	for (const filename of filenames) {
		const match = migrationFilenamePattern.exec(filename);
		if (!match) {
			errors.push(`Invalid PostgreSQL migration filename: ${filename}`);
			continue;
		}

		const prefix = String(Number(match[1])).padStart(4, "0");
		const names = namesByPrefix.get(prefix) ?? [];
		names.push(filename);
		namesByPrefix.set(prefix, names);
	}

	for (const [prefix, names] of namesByPrefix) {
		if (names.length < 2) continue;

		const expectedNames = legacyDuplicatePrefixes.get(prefix);
		const actualNames = [...names].sort();
		if (
			expectedNames &&
			actualNames.length === expectedNames.length &&
			actualNames.every((name, index) => name === expectedNames[index])
		) {
			continue;
		}

		errors.push(
			`Duplicate PostgreSQL migration prefix ${prefix}: ${actualNames.join(", ")}`,
		);
	}

	return errors;
}

export function verifyMigrationDirectory(directory: string): string[] {
	return validateMigrationFilenames(
		readdirSync(directory).filter((filename) => filename.endsWith(".sql")),
	);
}

if (import.meta.main) {
	const migrationDirectory = resolve(import.meta.dir, "../db/migrations");
	const errors = verifyMigrationDirectory(migrationDirectory);
	if (errors.length > 0) {
		console.error(errors.join("\n"));
		process.exit(1);
	}

	console.log("PostgreSQL migration filenames are valid.");
}
