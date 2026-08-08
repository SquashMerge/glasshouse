import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/db/migrations/0039_durable_basic_auth_actors.sql",
	),
	"utf8",
);
const bootstrapAuthorization = readFileSync(
	resolve(import.meta.dir, "../../src/db/bootstrap-authorization.ts"),
	"utf8",
);
const migrationAssertions = readFileSync(
	resolve(
		import.meta.dir,
		"../../../../infra/scripts/test-db-migrations-0039.assert.sql",
	),
	"utf8",
);

test("uses PostgreSQL Unicode-normalization form keywords", () => {
	for (const source of [
		migration,
		bootstrapAuthorization,
		migrationAssertions,
	]) {
		expect(source).not.toContain("'NFKC'");
		expect(source).toContain("NFKC");
	}
});
