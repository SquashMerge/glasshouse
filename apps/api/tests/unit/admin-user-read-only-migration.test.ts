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
const migrationAssertion = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations.assert.sql",
	),
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
const cancellationIdentityRepairMigration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0049_execution_admission_cancellation_identity_fix.sql",
	),
	"utf8",
);
const cancellationIdentityRepairFixture = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0049.fixture.sql",
	),
	"utf8",
);
const cancellationIdentityRepairAssertion = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0049.assert.sql",
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

test("covers deleting project cleanup without its marker and protects the final Admin from it", () => {
	const lifecycleBlock = migrationAssertion.slice(
		migrationAssertion.indexOf("Project Deletion Lifecycle Guard"),
		migrationAssertion.indexOf("Permanent Deletion Fixture"),
	);
	const marker =
		"PERFORM set_config('astraea.project_deletion_id', test_project_id::text, true);";
	const clearedMarker =
		"PERFORM set_config('astraea.project_deletion_id', '', true);";
	const deletingStatus = "SET status = 'deleting'";

	expect(lifecycleBlock).toContain(marker);
	expect(lifecycleBlock).toContain(clearedMarker);
	expect(lifecycleBlock.indexOf(clearedMarker)).toBeGreaterThan(
		lifecycleBlock.indexOf(marker),
	);
	expect(lifecycleBlock.indexOf(deletingStatus)).toBeGreaterThan(
		lifecycleBlock.indexOf(clearedMarker),
	);
	expect(lifecycleBlock).toContain("DELETE FROM organization_memberships");
	expect(lifecycleBlock).toContain(
		"final organization Admin guard did not preserve its membership",
	);
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

test("scopes the bootstrap default-project assertion to its organization", () => {
	expect(migrationAssertion).toContain(
		"FROM organizations AS organization\n\t\tJOIN projects AS project\n\t\t\tON project.id = organization.default_project_id\n\t\t\tAND project.organization_id = organization.id",
	);
	expect(migrationAssertion).toContain(
		"WHERE organization.id = '00000000-0000-4000-8000-000000000001'\n\t\t\tAND organization.slug = 'default'\n\t\t\tAND organization.name = 'Default Organization'\n\t\t\tAND project.slug = 'default'\n\t\t\tAND project.name = 'Default Project'",
	);
	expect(migrationAssertion).not.toContain(
		"IF (SELECT count(*) FROM projects WHERE slug = 'default') <> 1\n        OR (SELECT name FROM projects WHERE slug = 'default') <> 'Default Project'",
	);
});

test("scopes historical migration outputs to their fixture rows", () => {
	const historicalProjectIds = [
		"11111111-1111-1111-1111-111111111111",
		"22222222-2222-2222-2222-222222222222",
		"44444444-4444-4444-8444-444444444444",
	];
	const legacyProjectBackfillAssertion = migrationAssertion.slice(
		migrationAssertion.indexOf("FROM projects\n        WHERE id IN ("),
		migrationAssertion.indexOf(
			"legacy projects were not backfilled to the default organization",
		),
	);
	const bootstrapAuthorizationAssertion = migrationAssertion.slice(
		migrationAssertion.indexOf("FROM project_memberships AS pm"),
		migrationAssertion.indexOf(
			"bootstrap owner was not idempotently granted manager membership",
		),
	);
	const promptLabelAssertion = migrationAssertion.slice(
		migrationAssertion.indexOf(
			"(original_project_id, original_prompt_id, original_version_id, original_label) IN (",
		),
		migrationAssertion.indexOf(
			"valid labels were not retained and restored exactly",
		),
	);

	expect(migrationAssertion).not.toContain(
		"FROM projects\n        WHERE organization_id <> '00000000-0000-4000-8000-000000000001'",
	);
	for (const projectId of historicalProjectIds)
		expect(legacyProjectBackfillAssertion).toContain(projectId);
	expect(legacyProjectBackfillAssertion).toContain(
		"AND organization_id <> '00000000-0000-4000-8000-000000000001'",
	);
	expect(migrationAssertion).not.toContain(
		"IF (SELECT count(*) FROM projects WHERE slug = 'default') <> 2",
	);
	expect(migrationAssertion).toContain(
		"WHERE organization_id = '00000000-0000-4000-8000-000000000001'\n            AND slug = 'default'",
	);
	expect(migrationAssertion).toContain(
		"WHERE id = '33333333-3333-4333-8333-333333333333'\n            AND organization_id = '00000000-0000-4000-8000-000000000002'\n            AND slug = 'default'",
	);

	expect(bootstrapAuthorizationAssertion).toContain(
		"pm.project_id IN (\n                    '11111111-1111-1111-1111-111111111111'",
	);
	expect(bootstrapAuthorizationAssertion).toContain(
		"p.id IN (\n                        '11111111-1111-1111-1111-111111111111'",
	);
	expect(bootstrapAuthorizationAssertion).toContain(
		"FROM project_authorization_audit_events\n            WHERE organization_id = '00000000-0000-4000-8000-000000000001'\n                AND actor_subject = 'bootstrap-owner'\n                AND event_type = 'bootstrap_manager_added'\n                AND (\n                    project_id IN (",
	);
	expect(bootstrapAuthorizationAssertion).toContain(
		"SELECT default_project_id\n                    FROM organizations\n                    WHERE id = '00000000-0000-4000-8000-000000000001'",
	);
	for (const projectId of historicalProjectIds)
		expect(bootstrapAuthorizationAssertion.split(projectId)).toHaveLength(4);
	expect(
		bootstrapAuthorizationAssertion.split("SELECT default_project_id"),
	).toHaveLength(4);
	expect(migrationAssertion).not.toContain(
		"count(*) FROM project_memberships WHERE organization_id = '00000000-0000-4000-8000-000000000001' AND actor_subject = 'bootstrap-owner' AND role = 'manager'",
	);
	expect(migrationAssertion).not.toContain(
		"WHERE p.organization_id = '00000000-0000-4000-8000-000000000001'\n                AND NOT EXISTS",
	);
	expect(migrationAssertion).not.toContain(
		"count(*) FROM project_authorization_audit_events WHERE actor_subject = 'bootstrap-owner' AND event_type = 'bootstrap_manager_added'",
	);

	expect(promptLabelAssertion).toContain(
		"(original_project_id, original_prompt_id, original_version_id, original_label) IN (",
	);
	for (const tuple of [
		"('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101', 'invalid!')",
		"('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101', 'latest')",
		"('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000101', 'tenant')",
		"('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000101', 'version-link')",
	])
		expect(promptLabelAssertion).toContain(tuple);
	for (const reason of [
		"invalid_label_format",
		"reserved_latest",
		"prompt_project_mismatch",
		"version_prompt_mismatch",
	])
		expect(promptLabelAssertion).toContain(reason);
	expect(promptLabelAssertion).toContain(
		"WHERE project_id = '11111111-1111-1111-1111-111111111111'\n            AND prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'\n            AND version_id = 'aaaaaaaa-0000-0000-0000-000000000101'",
	);
	expect(migrationAssertion).not.toContain(
		"IF (SELECT count(*) FROM prompt_label_quarantine) <> 4",
	);
	expect(migrationAssertion).not.toContain(
		"IF (SELECT count(*) FROM prompt_labels) <> 2",
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

test("repairs execution cancellation with the durable Basic Auth actor identity", () => {
	expect(cancellationIdentityRepairMigration).toContain(
		"job.requested_by,\n                      target_actor_id",
	);
	expect(cancellationIdentityRepairMigration).toContain(
		"target_actor_id IS NOT NULL AND requester_actor_id = target_actor_id",
	);
	expect(cancellationIdentityRepairFixture).toContain(
		"cancellation-unmapped-user",
	);
	expect(cancellationIdentityRepairAssertion).toContain(
		"unmapped membership revocation cancelled another actor work",
	);
	expect(cancellationIdentityRepairAssertion).toContain(
		"project archive did not cancel all remaining work",
	);
	expect(migrationHarness).toContain("UPGRADE_0049_DATABASE");
	expect(migrationHarness).toContain("test-db-migrations-0049.fixture.sql");
	expect(migrationHarness).toContain("test-db-migrations-0049.assert.sql");
});
