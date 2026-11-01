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

test("snapshot migration stores bounded identifiers and keys, not log payloads", () => {
	const snapshot = readFileSync(
		resolve(
			import.meta.dir,
			"../../db/migrations/90059_internal_log_snapshots.sql",
		),
		"utf8",
	);
	expect(snapshot).toContain(
		"organization_id UUID NOT NULL REFERENCES organizations(id)",
	);
	expect(snapshot).toContain("actor_id UUID NOT NULL REFERENCES actors(id)");
	expect(snapshot).toContain("cardinality(entry_ids) <= 50000");
	expect(snapshot).toContain("<= 1250000");
	expect(snapshot).toContain("internal_log_snapshots_expiry_idx");
	expect(snapshot).not.toContain("context JSONB");
});
