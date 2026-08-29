import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationPath = resolve(
	import.meta.dir,
	"../../../../infra/db/migrations/0074_durable_project_restore_guard.sql",
);
const fixturePath = resolve(
	import.meta.dir,
	"../../../../infra/scripts/test-db-migrations-0074.fixture.sql",
);
const preAssertionsPath = resolve(
	import.meta.dir,
	"../../../../infra/scripts/test-db-migrations-0074.pre.assert.sql",
);
const assertionsPath = resolve(
	import.meta.dir,
	"../../../../infra/scripts/test-db-migrations-0074.assert.sql",
);
const readIfPresent = (path: string) =>
	existsSync(path) ? readFileSync(path, "utf8") : "";
const migration = readIfPresent(migrationPath);
const fixture = readIfPresent(fixturePath);
const preAssertions = readIfPresent(preAssertionsPath);
const assertions = readIfPresent(assertionsPath);
const migrationHarness = readFileSync(
	resolve(import.meta.dir, "../../../../infra/scripts/test-db-migrations.sh"),
	"utf8",
);

test("0074 restores archived Projects through durable project management policy", () => {
	expect(existsSync(migrationPath)).toBe(true);
	expect(migration).toContain(
		"CREATE OR REPLACE FUNCTION prevent_managerless_project_restore()",
	);
	expect(migration).toContain("FROM organization_actor_roles role");
	expect(migration).toContain("JOIN actor_identities identity");
	expect(migration).toContain("authorization_allows_project(");
	expect(migration).toContain("NEW.organization_id");
	expect(migration).toContain("NEW.id");
	expect(migration).toContain("role.actor_id");
	expect(migration).toContain("'project_manage'");
	expect(migration).not.toContain("FROM project_memberships");
});

test("0074 upgrade fixture proves restore without a fabricated legacy projection", () => {
	expect(existsSync(fixturePath)).toBe(true);
	expect(existsSync(preAssertionsPath)).toBe(true);
	expect(existsSync(assertionsPath)).toBe(true);
	expect(fixture).toContain("INSERT INTO actor_identities");
	expect(fixture).toContain("INSERT INTO organization_actor_roles");
	expect(fixture).not.toContain("INSERT INTO organization_memberships");
	expect(fixture).not.toContain("INSERT INTO project_memberships");
	expect(preAssertions).toContain("cannot restore a project without a manager");
	expect(assertions).toContain("UPDATE projects");
	expect(assertions).toContain("organization_memberships");
	expect(assertions).toContain("project_memberships");

	const upgrade = migrationHarness.slice(
		migrationHarness.indexOf("UPGRADE_0074_DATABASE"),
		migrationHarness.indexOf("UPGRADE_0050_NULL_ORGANIZATION_DATABASE"),
	);
	expect(upgrade).toContain("test-db-migrations-0074.fixture.sql");
	expect(upgrade).toContain("test-db-migrations-0074.pre.assert.sql");
	expect(
		upgrade.match(/0074_durable_project_restore_guard\.sql/g),
	).toHaveLength(2);
	expect(upgrade).toContain("test-db-migrations-0074.assert.sql");
});
