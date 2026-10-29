import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(
	new URL(
		"../../../../infra/db/migrations/0108_project_otlp_ingestion_credentials.sql",
		import.meta.url,
	),
	"utf8",
);

test("OTLP credential migration persists only a digest with organization, Project, and creator scope", () => {
	expect(migration).toContain(
		"secret_digest TEXT NOT NULL UNIQUE CHECK (secret_digest ~ '^[0-9a-f]{64}$')",
	);
	expect(migration).toContain("FOREIGN KEY (project_id, organization_id)");
	expect(migration).toContain(
		"REFERENCES projects(id, organization_id) ON DELETE CASCADE",
	);
	expect(migration).toContain(
		"FOREIGN KEY (organization_id, created_by_actor_id)",
	);
	expect(migration).not.toMatch(/\bsecret\s+TEXT\b/i);
	expect(migration).toContain("'project_otlp_credential_created'");
	expect(migration).toContain("'project_otlp_credential_rotated'");
	expect(migration).toContain("'project_otlp_credential_revoked'");
});
