import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
	resolve(import.meta.dir, "../../db/migrations/90058_internal_logs.sql"),
	"utf8",
);

test("internal log migration scopes, bounds, and indexes the searchable store", () => {
	expect(migration).toContain(
		"organization_id UUID NOT NULL REFERENCES organizations(id)",
	);
	expect(migration).toContain("severity IN ('debug', 'info', 'warn', 'error')");
	expect(migration).toContain("source = 'api'");
	expect(migration).toContain("message = 'API request outcome'");
	expect(migration).toContain("context JSONB NOT NULL");
	expect(migration).toContain("(organization_id, recorded_at DESC, id DESC)");
	expect(migration).toContain("internal_log_entries_recorded_at_idx");
});
