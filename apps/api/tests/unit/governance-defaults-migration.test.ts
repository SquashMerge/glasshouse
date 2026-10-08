import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../..");
const migration = readFileSync(
	resolve(root, "infra/db/migrations/0105_governance_policy_defaults.sql"),
	"utf8",
);
const migrationAssertions = readFileSync(
	resolve(root, "infra/scripts/test-db-migrations-0105.assert.sql"),
	"utf8",
);
const migrationHarness = readFileSync(
	resolve(root, "infra/scripts/test-db-migrations.sh"),
	"utf8",
);
const actorIdentityMigration = readFileSync(
	resolve(
		root,
		"infra/db/migrations/0106_governance_approval_actor_identity.sql",
	),
	"utf8",
);
const serializationIntegration = readFileSync(
	resolve(
		root,
		"apps/api/tests/integration/authorization-revocation-serialization.test.ts",
	),
	"utf8",
);

test("0105 provisions one immutable approved baseline for existing and new Projects", () => {
	const ensureFunction = migration.split(
		"CREATE OR REPLACE FUNCTION provision_default_governance_policy_for_project",
	)[0];
	expect(ensureFunction).toContain(
		"CREATE OR REPLACE FUNCTION ensure_default_governance_policy",
	);
	expect(ensureFunction).not.toMatch(
		/FROM\s+(?:organization_memberships|organization_actor_roles|project_memberships)[\s\S]{0,160}FOR UPDATE/i,
	);
	expect(migration).toContain(
		"CREATE TRIGGER projects_default_governance_policy",
	);
	expect(migration).toContain("AFTER INSERT ON projects");
	expect(migration).toContain(
		"lock_project_audit_provenance(target_project_id)",
	);
	expect(migration).toContain("INSERT INTO governance_policy_versions");
	expect(migration).toContain("INSERT INTO governance_policy_approvals");
	expect(migration).toContain("'policy_created'");
	expect(migration).toContain("'policy_approved'");
	expect(migration).toContain("'system:governance-defaults'");
	expect(migration).toContain("'traces', 30");
	expect(migration).toContain("'datasets', 90");
	expect(migration).toContain("'feedback', 90");
	expect(migration).toContain("'none'");
	expect(migration).not.toContain("governance_retention_runs");
	expect(migrationAssertions).toContain("custom approved policy was replaced");
	expect(migrationAssertions).toContain("draft history was changed");
	expect(migrationAssertions).toContain(
		"default policy provisioning was not idempotent",
	);
	expect(migrationAssertions).toContain(
		"new project did not receive the approved default policy",
	);
	expect(migrationHarness).toContain("test-db-migrations-0105.assert.sql");
});

test("0106 preserves durable actor identity separately from legacy approval subjects", () => {
	expect(actorIdentityMigration).toContain(
		"ADD COLUMN IF NOT EXISTS approved_by_actor_id UUID",
	);
	expect(actorIdentityMigration).toContain("REFERENCES actors(id)");
	expect(actorIdentityMigration).toContain("ON DELETE RESTRICT");
	expect(actorIdentityMigration).not.toContain(
		"UPDATE governance_policy_approvals",
	);
});

test("governance fixture cleanup removes audit rows before disabling cascades", () => {
	const versionCleanupWindows = [
		...serializationIntegration.matchAll(
			/SET LOCAL session_replication_role = origin([\s\S]*?)SET LOCAL session_replication_role = replica/g,
		),
	];
	expect(versionCleanupWindows).toHaveLength(2);
	for (const cleanup of versionCleanupWindows) {
		expect(cleanup[1]).toContain(
			"DELETE FROM governance_audit_events WHERE project_id = $1",
		);
		expect(cleanup[1]).toContain(
			"DELETE FROM governance_policy_versions WHERE project_id = $1",
		);
	}
});
