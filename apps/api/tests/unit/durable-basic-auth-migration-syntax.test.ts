import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0039_durable_basic_auth_actors.sql",
	),
	"utf8",
);
const bootstrapAuthorization = readFileSync(
	resolve(import.meta.dir, "../../src/db/bootstrap-authorization.ts"),
	"utf8",
);
const migrationAssertions = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0039.assert.sql",
	),
	"utf8",
);
const migrationFixture = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0039.fixture.sql",
	),
	"utf8",
);
const internalEvaluationMigration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0040_internal_evaluation_worker_actors.sql",
	),
	"utf8",
);
const internalEvaluationMigrationHarness = readFileSync(
	resolve(import.meta.dir, "../../../../infra/scripts/test-db-migrations.sh"),
	"utf8",
);

test("uses PostgreSQL Unicode-normalization form keywords", () => {
	for (const source of [
		migration,
		bootstrapAuthorization,
		migrationAssertions,
	]) {
		expect(source).not.toContain("'NFKC'");
		expect(source).toContain("NFKC");
	}
});

test("keeps backfill quarantine tenant-scoped", () => {
	const quarantineTable = migration.slice(
		migration.indexOf(
			"CREATE TABLE IF NOT EXISTS actor_identity_backfill_quarantine",
		),
		migration.indexOf(
			");",
			migration.indexOf(
				"CREATE TABLE IF NOT EXISTS actor_identity_backfill_quarantine",
			),
		) + 2,
	);
	expect(quarantineTable).toContain(
		"organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT",
	);
});

test("builds the migration fixture organization and default project without bypassing its foreign key", () => {
	expect(migrationFixture).toContain(
		"ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;",
	);
	expect(migrationFixture).toContain(
		"UPDATE organizations SET default_project_id = '99999999-9999-4999-8999-999999999998'",
	);
	expect(migrationFixture).toContain(
		"ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;",
	);
});

test("provisions and verifies tenant-bound internal evaluation identities", () => {
	expect(internalEvaluationMigration).toContain(
		"internal:evaluation-worker:v1",
	);
	expect(internalEvaluationMigration).toContain(
		"durable_actor_id(\n        internal_provider_namespace,\n        target_organization_id::text",
	);
	expect(internalEvaluationMigration).toContain(
		"RAISE EXCEPTION 'internal evaluation worker identity does not match organization'",
	);
	expect(internalEvaluationMigration).toContain(
		"RAISE EXCEPTION 'internal evaluation worker actor ID is already linked or orphaned'",
	);
	expect(internalEvaluationMigration).toContain(
		"AFTER INSERT ON organizations",
	);
	expect(internalEvaluationMigrationHarness).toContain(
		"test-db-migrations-0040.assert.sql",
	);
	expect(internalEvaluationMigrationHarness).toContain(
		"0040 migration accepted a mismatched internal evaluation actor",
	);
	expect(internalEvaluationMigrationHarness).toContain(
		"0040 migration accepted a cross-provider internal actor ID collision",
	);
});
