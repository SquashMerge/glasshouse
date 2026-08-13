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
const experimentRequesterFixture = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0042.fixture.sql",
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
const executionAdmissionAssertion = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0044.assert.sql",
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
const quarantineTenantScopeMigration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0050_authorization_role_migration_quarantine_tenant_scope.sql",
	),
	"utf8",
);
const quarantineTenantScopeFixture = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0050.fixture.sql",
	),
	"utf8",
);
const quarantineTenantScopeAssertion = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0050.assert.sql",
	),
	"utf8",
);
const adminMembershipProjectGrantsAssertion = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0051.assert.sql",
	),
	"utf8",
);
const adminMembershipProjectGrantsFixture = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0051.fixture.sql",
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

test("makes the 0042 requester-authorization upgrade fixture independent of 0041", () => {
	expect(experimentRequesterFixture).toContain(
		"ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;",
	);
	expect(experimentRequesterFixture).toContain(
		"INSERT INTO organizations (id, name, slug)",
	);
	expect(experimentRequesterFixture).toContain(
		"INSERT INTO projects (id, name, slug, organization_id)",
	);
	expect(experimentRequesterFixture).toContain(
		"SET default_project_id = '66666666-6666-4666-8666-666666666665'",
	);
	expect(experimentRequesterFixture).toContain(
		"ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;",
	);
	expect(experimentRequesterFixture).toContain(
		"INSERT INTO actors (id)\nVALUES ('66666666-6666-4666-8666-666666666601')",
	);
	expect(experimentRequesterFixture).toContain(
		"'66666666-6666-4666-8666-666666666601',\n    '66666666-6666-4666-8666-666666666666',\n    'basic:v1',\n    'legacy-admin'",
	);
	expect(
		experimentRequesterFixture.split("ON CONFLICT DO NOTHING"),
	).toHaveLength(3);
	expect(experimentRequesterFixture).toContain(
		"'66666666-6666-4666-8666-666666666620'",
	);
	expect(experimentRequesterFixture).toContain("Historical unbound experiment");
	expect(experimentRequesterFixture).not.toContain("0041.fixture");
	for (const unrelatedFixtureData of [
		"organization_memberships",
		"project_memberships",
		"authorization_role_migration_",
		"legacy-user",
		"legacy-reader",
	])
		expect(experimentRequesterFixture).not.toContain(unrelatedFixtureData);
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
		expect(bootstrapAuthorizationAssertion.split(projectId)).toHaveLength(5);
	expect(
		bootstrapAuthorizationAssertion.split("SELECT default_project_id"),
	).toHaveLength(5);
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
		"('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'aaaaaaaa-0000-0000-0000-000000000101'::uuid, 'invalid!')",
		"('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'aaaaaaaa-0000-0000-0000-000000000101'::uuid, 'latest')",
		"('22222222-2222-2222-2222-222222222222'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'aaaaaaaa-0000-0000-0000-000000000101'::uuid, 'tenant')",
		"('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'bbbbbbbb-0000-0000-0000-000000000101'::uuid, 'version-link')",
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

test("requires a scoped bootstrap audit event for every historical project", () => {
	const bootstrapAuthorizationAssertion = migrationAssertion.slice(
		migrationAssertion.indexOf("FROM project_memberships AS pm"),
		migrationAssertion.indexOf(
			"bootstrap owner was not idempotently granted manager membership",
		),
	);

	expect(bootstrapAuthorizationAssertion).toContain(
		"OR EXISTS (\n            SELECT 1\n            FROM projects AS p\n            WHERE p.organization_id = '00000000-0000-4000-8000-000000000001'\n                AND (\n                    p.id IN (\n                        '11111111-1111-1111-1111-111111111111',\n                        '22222222-2222-2222-2222-222222222222',\n                        '44444444-4444-4444-8444-444444444444'\n                    ) OR p.id = (\n                        SELECT default_project_id\n                        FROM organizations\n                        WHERE id = '00000000-0000-4000-8000-000000000001'\n                    )\n                )\n                AND NOT EXISTS (\n                    SELECT 1\n                    FROM project_authorization_audit_events AS event\n                    WHERE event.organization_id = '00000000-0000-4000-8000-000000000001'\n                        AND event.project_id = p.id\n                        AND event.actor_subject = 'bootstrap-owner'\n                        AND event.event_type = 'bootstrap_manager_added'\n                )\n        )",
	);
});

test("types every UUID in scoped prompt-label quarantine tuples", () => {
	const promptLabelAssertion = migrationAssertion.slice(
		migrationAssertion.indexOf(
			"(original_project_id, original_prompt_id, original_version_id, original_label) IN (",
		),
		migrationAssertion.indexOf(
			"valid labels were not retained and restored exactly",
		),
	);

	for (const tuple of [
		"('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'aaaaaaaa-0000-0000-0000-000000000101'::uuid, 'invalid!')",
		"('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'aaaaaaaa-0000-0000-0000-000000000101'::uuid, 'latest')",
		"('22222222-2222-2222-2222-222222222222'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'aaaaaaaa-0000-0000-0000-000000000101'::uuid, 'tenant')",
		"('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'bbbbbbbb-0000-0000-0000-000000000101'::uuid, 'version-link')",
	])
		expect(promptLabelAssertion).toContain(tuple);
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

test("keeps the 0049 cancellation fixture legal without bypassing the final User guard", () => {
	const organizationMemberships = cancellationIdentityRepairFixture.slice(
		cancellationIdentityRepairFixture.indexOf(
			"INSERT INTO organization_memberships",
		),
		cancellationIdentityRepairFixture.indexOf(
			"INSERT INTO project_memberships",
		),
	);
	const projectMemberships = cancellationIdentityRepairFixture.slice(
		cancellationIdentityRepairFixture.indexOf(
			"INSERT INTO project_memberships",
		),
		cancellationIdentityRepairFixture.indexOf("INSERT INTO datasets"),
	);
	const mappedRevocation = cancellationIdentityRepairAssertion.slice(
		cancellationIdentityRepairAssertion.indexOf(
			"UPDATE project_memberships\n    SET role = 'member'\n    WHERE project_id = repair_project_id\n      AND actor_subject = 'cancellation-matched-user';",
		),
		cancellationIdentityRepairAssertion.indexOf(
			"INSERT INTO prompt_optimization_jobs",
		),
	);
	const finalUserGuard = migration.slice(
		migration.indexOf(
			"CREATE OR REPLACE FUNCTION prevent_final_workspace_role_removal",
		),
		migration.indexOf("RETURN COALESCE(NEW, OLD);"),
	);

	for (const memberships of [organizationMemberships, projectMemberships])
		expect(memberships.match(/cancellation-[a-z-]+-user/g)).toHaveLength(3);
	expect(organizationMemberships).toContain(
		"'49000000-0000-4000-8000-000000000001', 'cancellation-control-user', 'member'",
	);
	expect(projectMemberships).toContain(
		"'49000000-0000-4000-8000-000000000003', '49000000-0000-4000-8000-000000000001', 'cancellation-control-user', 'manager'",
	);
	expect(mappedRevocation).toContain(
		"actor_subject = 'cancellation-control-user'\n          AND role = 'manager'",
	);
	expect(mappedRevocation).toContain(
		"0049 fixture did not retain an active project User",
	);
	expect(finalUserGuard).toContain(
		"IF OLD.role = 'manager'\n            AND (TG_OP = 'DELETE' OR NEW.role <> OLD.role)\n            AND EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND status = 'active')\n            AND NOT EXISTS (",
	);
	expect(finalUserGuard).toContain(
		"RAISE EXCEPTION 'cannot remove or demote the final active project User';",
	);
});

test("keeps historical 0044 replay free of broken cancellation DML", () => {
	expect(executionAdmissionAssertion).not.toMatch(
		/\b(?:INSERT|UPDATE|DELETE|PERFORM)\b/,
	);
});

test("covers cancellation behavior after 0049 resolves the requester actor ID", () => {
	expect(cancellationIdentityRepairMigration).toContain(
		"target_actor_id IS NOT NULL\n                  AND basic_auth_identity_matches(\n                      target_organization_id,\n                      job.requested_by,\n                      target_actor_id",
	);
	for (const message of [
		"0049 unmapped membership revocation cancelled another actor work",
		"0049 mapped membership revocation did not cancel matching experiment work",
		"0049 mapped membership revocation did not cancel matching optimization work",
		"0049 project archive did not cancel all remaining work",
	])
		expect(cancellationIdentityRepairAssertion).toContain(message);
	expect(cancellationIdentityRepairAssertion).toContain(
		"FROM experiment_tasks",
	);
});

test("preserves only explicitly project-null tenant identifier records", () => {
	const tenantIdentifierNullabilityAssertion = migrationAssertion.slice(
		migrationAssertion.indexOf("FROM information_schema.columns"),
		migrationAssertion.indexOf("tenant identifier columns must be NOT NULL"),
	);

	expect(quarantineTenantScopeMigration).toContain(
		"WHERE organization_id IS NULL",
	);
	expect(quarantineTenantScopeMigration).toContain(
		"authorization role migration quarantine rows missing organization scope",
	);
	expect(quarantineTenantScopeMigration).toContain(
		"ALTER COLUMN organization_id SET NOT NULL",
	);
	expect(quarantineTenantScopeMigration).not.toContain(
		"UPDATE authorization_role_migration_quarantine",
	);
	expect(migrationHarness).toContain("UPGRADE_0050_DATABASE");
	expect(migrationHarness).toContain("UPGRADE_0050_NULL_ORGANIZATION_DATABASE");
	expect(migrationHarness).toContain(
		"test-db-migrations-0050-null-organization.fixture.sql",
	);
	expect(tenantIdentifierNullabilityAssertion).toContain(
		"AND (table_name, column_name) NOT IN (\n                ('authorization_role_migration_audit', 'project_id'),\n                ('authorization_role_migration_quarantine', 'project_id'),\n                ('admin_access_audit_events', 'project_id')\n            )",
	);
	expect(tenantIdentifierNullabilityAssertion).not.toContain(
		"('authorization_role_migration_audit', 'organization_id')",
	);
	expect(tenantIdentifierNullabilityAssertion).not.toContain(
		"('authorization_role_migration_quarantine', 'organization_id')",
	);
	expect(tenantIdentifierNullabilityAssertion).not.toContain(
		"('admin_access_audit_events', 'organization_id')",
	);
	expect(tenantIdentifierNullabilityAssertion).toContain(
		"column_name IN ('organization_id', 'project_id')",
	);
	expect(quarantineTenantScopeFixture).toContain(
		"project_id,\n    actor_subject",
	);
	expect(quarantineTenantScopeFixture).toContain(
		"NULL,\n    '0050-organization",
	);
	expect(quarantineTenantScopeAssertion).toContain(
		"0050 accepted a quarantine record without organization scope",
	);
	expect(quarantineTenantScopeAssertion).toContain(
		"EXCEPTION WHEN not_null_violation",
	);
	expect(adminMembershipProjectGrantsAssertion).toContain(
		"PERFORM audit_admin_access_event(\n        fixture_organization_id,\n        NULL,\n        fixture_owner_id,\n        fixture_owner_id,\n        'bootstrap_owner_granted'\n    );",
	);
	expect(adminMembershipProjectGrantsAssertion).toContain(
		"WHERE organization_id = fixture_organization_id\n          AND project_id IS NULL\n          AND actor_id = fixture_owner_id\n          AND target_actor_id = fixture_owner_id\n          AND action = 'bootstrap_owner_granted'",
	);
	expect(adminMembershipProjectGrantsAssertion).toContain(
		"WHERE organization_id = fixture_organization_id\n          AND project_id = fixture_project_id\n          AND actor_id = fixture_owner_id\n          AND target_actor_id = fixture_reader_id\n          AND action = 'project_grant_set'",
	);
});

test("stages the 0051 fixture default projects before assigning scoped defaults", () => {
	const dropNotNull =
		"ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;";
	const organizationInsert =
		"INSERT INTO organizations (id, name, slug) VALUES";
	const projectInsert =
		"INSERT INTO projects (id, organization_id, name, slug) VALUES";
	const defaultAssignment = `UPDATE organizations
SET default_project_id = CASE id
    WHEN '51000000-0000-4000-8000-000000000001' THEN '51000000-0000-4000-8000-000000000010'
    WHEN '51000000-0000-4000-8000-000000000002' THEN '51000000-0000-4000-8000-000000000020'
END
WHERE id IN (
    '51000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000002'
);`;
	const restoreNotNull =
		"ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;";

	expect(adminMembershipProjectGrantsFixture).toContain(dropNotNull);
	expect(adminMembershipProjectGrantsFixture).toContain(organizationInsert);
	expect(adminMembershipProjectGrantsFixture).not.toContain(
		"INSERT INTO organizations (id, name, slug, default_project_id)",
	);
	expect(adminMembershipProjectGrantsFixture).toContain(
		"('51000000-0000-4000-8000-000000000010', '51000000-0000-4000-8000-000000000001', 'Admin default', 'default')",
	);
	expect(adminMembershipProjectGrantsFixture).toContain(
		"('51000000-0000-4000-8000-000000000020', '51000000-0000-4000-8000-000000000002', 'Other default', 'default')",
	);
	expect(adminMembershipProjectGrantsFixture).toContain(defaultAssignment);
	expect(adminMembershipProjectGrantsFixture).toContain(restoreNotNull);
	expect(adminMembershipProjectGrantsFixture).not.toContain(
		"ALTER TABLE organizations DROP CONSTRAINT",
	);
	expect(adminMembershipProjectGrantsAssertion).toContain(
		"FROM organizations AS organization\n        JOIN projects AS project\n            ON project.id = organization.default_project_id\n            AND project.organization_id = organization.id",
	);
	expect(adminMembershipProjectGrantsAssertion).toContain(
		"('51000000-0000-4000-8000-000000000001'::uuid, '51000000-0000-4000-8000-000000000010'::uuid)",
	);
	expect(adminMembershipProjectGrantsAssertion).toContain(
		"('51000000-0000-4000-8000-000000000002'::uuid, '51000000-0000-4000-8000-000000000020'::uuid)",
	);
	expect(adminMembershipProjectGrantsAssertion).toContain(
		"column_name = 'default_project_id'\n          AND is_nullable = 'NO'",
	);
	expect(
		adminMembershipProjectGrantsFixture.indexOf(organizationInsert),
	).toBeGreaterThan(adminMembershipProjectGrantsFixture.indexOf(dropNotNull));
	expect(
		adminMembershipProjectGrantsFixture.indexOf(projectInsert),
	).toBeGreaterThan(
		adminMembershipProjectGrantsFixture.indexOf(organizationInsert),
	);
	expect(
		adminMembershipProjectGrantsFixture.indexOf(defaultAssignment),
	).toBeGreaterThan(adminMembershipProjectGrantsFixture.indexOf(projectInsert));
	expect(
		adminMembershipProjectGrantsFixture.indexOf(restoreNotNull),
	).toBeGreaterThan(
		adminMembershipProjectGrantsFixture.indexOf(defaultAssignment),
	);
});
