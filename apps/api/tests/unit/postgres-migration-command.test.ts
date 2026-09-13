import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationHarness = readFileSync(
	resolve(import.meta.dir, "../../../../infra/scripts/test-db-migrations.sh"),
	"utf8",
);
const migrationRunner = readFileSync(
	resolve(import.meta.dir, "../../src/db/migrate.ts"),
	"utf8",
);

test("db:migrate validates filenames and tolerates the known legacy ordering inversion", () => {
	const packageJson = JSON.parse(
		readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
	) as { scripts: Record<string, string> };

	const migrationCommand = packageJson.scripts["db:migrate"];
	expect(migrationCommand).toContain(
		"bun run ../../infra/scripts/verify-pg-migration-filenames.ts",
	);
	expect(migrationCommand).toContain("bun run src/db/migrate.ts");
	expect(migrationCommand).not.toContain(
		"bun run src/db/prepare-0091-run-item-remediation.ts",
	);
});

test("Run-item remediation is ledgered by the migration runner", () => {
	const lock = migrationRunner.indexOf("SELECT pg_advisory_lock($1)");
	const migrations = migrationRunner.indexOf("await runner({");

	expect(lock).toBeGreaterThan(-1);
	expect(migrations).toBeGreaterThan(lock);
	expect(migrationRunner).not.toContain("prepare0091RunItemRemediation");
	expect(migrationRunner).toContain("lockValue: nodePgMigrateLockId");
	expect(migrationRunner).toContain('advisoryLockMode: "wait"');
	expect(migrationRunner).toContain("SELECT pg_advisory_unlock($1)");
	expect(migrationRunner).toContain("singleTransaction: true");
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

test("migration harness exercises ledgered occupied Run-item remediation", () => {
	expect(migrationHarness).toContain(
		"test-db-migrations-agent-introspection-upgrade.fixture.sql",
	);
	expect(migrationHarness).not.toContain(
		"prepare-0091-run-item-remediation.ts",
	);
	expect(migrationHarness).not.toContain('--set "include_report=');
	expect(migrationHarness).toContain("0094_*.sql");
	expect(migrationHarness).toContain(
		"test-db-migrations-0091-post-upgrade.fixture.sql",
	);
	expect(migrationHarness).toContain("CONCURRENT_0089_UPGRADE_DATABASE");
	expect(migrationHarness).toContain(
		"concurrent 0089 upgrade did not wait for the migration advisory lock",
	);
	expect(migrationHarness).toContain(
		"test-db-migrations-agent-introspection-upgrade.assert.sql",
	);
	expect(migrationHarness).toContain("ROLLBACK_0091_UPGRADE_DATABASE");
	expect(migrationHarness).toContain(
		"test-db-migrations-0091-rollback.assert.sql",
	);
});
