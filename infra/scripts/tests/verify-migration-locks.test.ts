import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const postgresHarness = readFileSync(
	new URL("../test-db-migrations.sh", import.meta.url),
	"utf8",
);
const workflow = readFileSync(
	new URL("../../../.github/workflows/ci.yml", import.meta.url),
	"utf8",
);

describe("distributed migration lock verification", () => {
	it("runs concurrent PostgreSQL migration clients with the real container password", () => {
		expect(postgresHarness).toContain(
		'DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB"',
	);
		expect(postgresHarness).not.toContain("postgres://$POSTGRES_USER:***@");
		expect(postgresHarness).toContain(
		"SELECT pg_advisory_lock(7241865325823964)",
	);
		expect(postgresHarness).toContain("run_db_migrate &");
		expect(postgresHarness).toContain(
		"concurrent node-pg-migrate runner did not wait for the advisory lock",
	);
	});

	it("queries ClickHouse migration metadata in the configured database", () => {
		expect(workflow).toContain(
		"'http://localhost:8123/?database=glasshouse'",
	);
	});
});
