import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0041_admin_user_read_only_authorization.sql",
	),
	"utf8",
);
const migrationHarness = readFileSync(
	resolve(import.meta.dir, "../../../../infra/scripts/test-db-migrations.sh"),
	"utf8",
);
const revocationFenceMigration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0043_authorization_revocation_fence.sql",
	),
	"utf8",
);
const revocationSerializationTest = readFileSync(
	resolve(
		import.meta.dir,
		"../integration/authorization-revocation-serialization.test.ts",
	),
	"utf8",
);
const executionAdmissionFixture = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0044.fixture.sql",
	),
	"utf8",
);
const durableEffectsFixture = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0047.fixture.sql",
	),
	"utf8",
);

test("adds replay-safe Admin/User/Read-only policy state without automatic cutover", () => {
	expect(migration).toContain(
		"CREATE TABLE IF NOT EXISTS authorization_policy_settings",
	);
	expect(migration).toContain(
		"strict_enforcement BOOLEAN NOT NULL DEFAULT false",
	);
	expect(migration).toContain(
		"CREATE TABLE IF NOT EXISTS authorization_role_migration_audit",
	);
	expect(migration).toContain(
		"CREATE TABLE IF NOT EXISTS authorization_role_migration_quarantine",
	);
	expect(migration).toContain("ON CONFLICT DO NOTHING");
});

test("maps only valid legacy records and denies quarantined legacy data", () => {
	expect(migration).toContain("'owner', 'admin'");
	expect(migration).toContain("'manager', 'user'");
	expect(migration).toContain("'member', 'read_only'");
	expect(migration).toContain("'malformed_legacy_role'");
	expect(migration).toContain("'orphaned_project_membership'");
	expect(migration).toContain("'cross_organization_subject'");
	expect(migration).toContain("authorization_effective_project_role");
	expect(migration).toContain("authorization_allows_project");
});

test("requires an explicit, quarantine-free serialized operator action before strict enforcement", () => {
	expect(migration).toContain("enable_admin_user_read_only_enforcement");
	expect(migration).toContain("FOR UPDATE");
	expect(migration).toContain(
		"unresolved authorization role migration quarantine",
	);
	expect(migration).toContain(
		"cannot enable strict enforcement without an Admin",
	);
	expect(migration).toContain(
		"cannot remove or demote the final organization Admin",
	);
});

test("replays the target-role upgrade fixture before accepting strict enforcement", () => {
	expect(migrationHarness).toContain("UPGRADE_0041_DATABASE");
	expect(migrationHarness).toContain("test-db-migrations-0041.fixture.sql");
	expect(migrationHarness).toContain("test-db-migrations-0041.assert.sql");
});

test("keeps post-default-project authorization seeds valid without weakening historical schemas", () => {
	for (const source of [
		revocationSerializationTest,
		executionAdmissionFixture,
		durableEffectsFixture,
	]) {
		expect(source).toContain(
			"INSERT INTO organizations (id, name, slug, default_project_id)",
		);
		expect(source).toContain("WITH organization AS");
	}
	for (const fixture of [executionAdmissionFixture, durableEffectsFixture])
		expect(fixture).not.toContain(
			"ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;",
		);
});

test("initializes future organizations in compatibility mode", () => {
	expect(migration).toContain("AFTER INSERT ON organizations");
	expect(migration).toContain("authorization_policy_settings");
});

test("replays the membership revocation fence before a concurrent authorization can write", () => {
	expect(revocationFenceMigration).toContain(
		"fence_authorization_membership_revocation",
	);
	expect(revocationFenceMigration).toContain("ORDER BY id");
	expect(revocationFenceMigration).toContain("FOR UPDATE");
	expect(migrationHarness).toContain("UPGRADE_0043_DATABASE");
	expect(migrationHarness).toContain("test-db-migrations-0043.assert.sql");
});

test("provides an idempotent operator readiness check before strict enforcement", () => {
	expect(migration).toContain("authorization_role_migration_readiness");
	expect(migration).toContain("unresolved_quarantine_count");
	expect(migration).toContain("has_admin");
});
