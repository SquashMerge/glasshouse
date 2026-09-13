import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const dockerfile = readFileSync(
	new URL("../../Dockerfile", import.meta.url),
	"utf8",
);
const postgresMigrationRunner = readFileSync(
	new URL("../../src/db/migrate.ts", import.meta.url),
	"utf8",
);

describe("production startup", () => {
	it("runs both schema migration systems concurrently before the API starts", () => {
		expect(packageJson.scripts.dev).toBe(
			"bun run migrate && bun run --watch src/index.ts",
		);
		expect(packageJson.scripts.migrate).toBe(
			"bun run --parallel db:migrate ch:migrate",
		);
		expect(packageJson.scripts["db:migrate"]).toContain(
			"bun run src/db/migrate.ts",
		);
		expect(postgresMigrationRunner).toContain('advisoryLockMode: "wait"');
		expect(packageJson.scripts.start).toBe(
			"bun run migrate && bun run src/index.ts",
		);
		expect(dockerfile).toContain(
			'CMD ["sh", "-c", "cd apps/api && bun run start"]',
		);
	});
});
