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
