import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0047_durable_execution_effects.sql",
	),
	"utf8",
);
const migrationHarness = readFileSync(
	resolve(import.meta.dir, "../../../../infra/scripts/test-db-migrations.sh"),
	"utf8",
);
const migrationFixture = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0047.fixture.sql",
	),
	"utf8",
);
const migrationAssertions = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0047.assert.sql",
	),
	"utf8",
);

test("keeps the historical effect backfill legal and fully identity-scoped", () => {
	const backfill = migration.slice(
		migration.indexOf("UPDATE execution_admission_claims AS claim"),
		migration.indexOf(
			"ALTER TABLE execution_admission_claims",
			migration.indexOf("UPDATE execution_admission_claims AS claim"),
		),
	);

	expect(backfill).toContain(
		"FROM execution_admissions AS admission,\n     execution_effects AS effect",
	);
	expect(backfill).toContain("WHERE claim.admission_id = admission.id");
	for (const predicate of [
		"effect.organization_id = admission.organization_id",
		"effect.project_id = admission.project_id",
		"effect.work_kind = admission.work_kind",
		"effect.work_id = admission.work_id",
		"effect.effect = claim.effect",
		"effect.operation_key = claim.effect_key",
		"claim.execution_effect_id IS NULL",
	]) {
		expect(backfill).toContain(predicate);
	}
	expect(backfill).not.toContain(
		"FROM execution_admissions AS admission\nJOIN execution_effects AS effect",
	);
});

test("replays and verifies isolated legacy effect claims in PostgreSQL", () => {
	expect(migrationHarness).toContain("UPGRADE_0047_DATABASE");
	expect(migrationHarness).toContain("test-db-migrations-0047.fixture.sql");
	expect(migrationHarness).toContain("test-db-migrations-0047.assert.sql");
	expect(migrationFixture).toContain("Cross-Tenant Admission Replay");
	expect(migrationAssertions).toContain(
		"0047 did not isolate legacy claim effect backfills by tenant",
	);
});
