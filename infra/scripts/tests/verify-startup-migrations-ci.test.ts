import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
	new URL("../../../.github/workflows/ci.yml", import.meta.url),
	"utf8",
);

describe("startup migration CI contract", () => {
	it("verifies both stores after application startup and API restart", () => {
		expect(workflow).toContain(
		"Verify startup migrations are complete after application boot and restart",
	);
		expect(workflow).toContain("SELECT count(*) FROM pgmigrations");
		expect(workflow).toContain(
		"SELECT count() FROM astraea_schema_migrations",
	);
		expect(workflow).toContain("restart api");
		expect(workflow).toMatch(
			/up --detach --no-deps --wait(?: --wait-timeout 180)? api/,
		);
	});
});
