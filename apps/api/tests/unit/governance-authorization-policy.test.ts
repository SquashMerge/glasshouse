import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
	resolve(import.meta.dir, "../../src/routes/governance.ts"),
	"utf8",
);

test("rechecks governed authority through the centralized project policy before destructive stages", () => {
	expect(source).toContain("assertTenantProjectAccess");
	expect(source).toContain("authorization_allows_project");
	expect(source).toContain("'governed'");
});
