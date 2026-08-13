import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0053_project_audit_provenance_serialization_recovery.sql",
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
		"../../../../infra/scripts/test-db-migrations-0053.fixture.sql",
	),
	"utf8",
);
const migrationAssertions = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0053.assert.sql",
	),
	"utf8",
);

test("0053 restores UUID provenance serialization without dropping retained audit sources", () => {
	const functionStart = migration.indexOf(
		"CREATE OR REPLACE FUNCTION prevent_project_audit_uuid_reuse()",
	);
	const functionBody = migration.slice(functionStart);
	const retainedAuditCheck = functionBody.slice(
		functionBody.indexOf("IF EXISTS ("),
		functionBody.indexOf(") THEN"),
	);
	const provenanceLock = "PERFORM lock_project_audit_provenance(NEW.id);";
	const retainedAuditSources = [
		"project_authorization_audit_events",
		"project_lifecycle_audit_events",
		"governance_audit_events",
		"admin_access_audit_events",
	];

	expect(functionStart).toBeGreaterThanOrEqual(0);
	expect(functionBody).toContain(provenanceLock);
	expect(retainedAuditCheck).toContain("UNION ALL");
	for (const source of retainedAuditSources) {
		expect(retainedAuditCheck).toContain(
			`FROM ${source} WHERE project_id = NEW.id`,
		);
		expect(functionBody.indexOf(provenanceLock)).toBeLessThan(
			functionBody.indexOf(`FROM ${source} WHERE project_id = NEW.id`),
		);
	}
	expect(functionBody).toContain(
		"RAISE EXCEPTION 'project UUID has retained audit provenance'",
	);
	expect(functionBody).toContain("USING ERRCODE = '23505';");
});

test("0053 isolated upgrade rejects reuse of a UUID retained only by admin access audit provenance", () => {
	const upgrade0053 = migrationHarness.slice(
		migrationHarness.indexOf("UPGRADE_0053_DATABASE"),
		migrationHarness.indexOf("UPGRADE_0050_NULL_ORGANIZATION_DATABASE"),
	);

	const migration0051 = "0051_admin_membership_project_grants_recovery.sql";
	const migration0052 =
		"0052_durable_authorization_revocation_cancellation.sql";
	const migration0053 =
		"0053_project_audit_provenance_serialization_recovery.sql";
	const fixture = "test-db-migrations-0053.fixture.sql";

	expect(upgrade0053).toContain(migration0051);
	expect(upgrade0053).toContain("test-db-migrations-0053.fixture.sql");
	expect(upgrade0053.match(new RegExp(migration0053, "g"))).toHaveLength(2);
	expect(upgrade0053).toContain("test-db-migrations-0053.assert.sql");
	expect(upgrade0053.indexOf(migration0051)).toBeLessThan(
		upgrade0053.indexOf(fixture),
	);
	expect(upgrade0053.indexOf(fixture)).toBeLessThan(
		upgrade0053.indexOf(migration0052),
	);
	expect(upgrade0053.indexOf(migration0052)).toBeLessThan(
		upgrade0053.indexOf(migration0053),
	);
	expect(migrationFixture).toContain("PERFORM audit_admin_access_event(");
	expect(migrationFixture).toContain(
		"DELETE FROM projects WHERE id = retired_project_id",
	);
	expect(migrationAssertions).toContain("FROM admin_access_audit_events");
	expect(migrationAssertions).toContain("INSERT INTO projects");
	expect(migrationAssertions).toContain("id = retired_project_id");
	expect(migrationAssertions).toContain("EXCEPTION WHEN unique_violation THEN");
	expect(migrationAssertions).toContain("RETURNED_SQLSTATE");
	expect(migrationAssertions).toContain("'23505'");
	expect(migrationAssertions).toContain(
		"project UUID has retained audit provenance",
	);
});
