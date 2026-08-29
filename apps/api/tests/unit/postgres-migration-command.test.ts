import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationHarness = readFileSync(
	resolve(import.meta.dir, "../../../../infra/scripts/test-db-migrations.sh"),
	"utf8",
);

test("db:migrate validates filenames and tolerates the known legacy ordering inversion", () => {
	const packageJson = JSON.parse(
		readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
	) as { scripts: Record<string, string> };

	expect(packageJson.scripts["db:migrate"]).toContain(
		"bun run ../../infra/scripts/verify-pg-migration-filenames.ts",
	);
	expect(packageJson.scripts["db:migrate"]).toContain("--check-order=false");
});

test("migration harness upgrades a database that recorded the prior 0023 order", () => {
	const legacyHarness = migrationHarness.slice(
		migrationHarness.indexOf("LEGACY_0023_ORDER_DATABASE"),
		migrationHarness.indexOf(
			"# These races require two live PostgreSQL connections.",
		),
	);

	expect(legacyHarness).toContain("0023_prompt_optimization_metric_calls");
	expect(legacyHarness).toContain("0023_project_workspace_authorization");
	expect(legacyHarness).toContain("psql --tuples-only --no-align");
});
