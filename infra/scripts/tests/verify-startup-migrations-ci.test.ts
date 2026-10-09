import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
	new URL("../../../.github/workflows/ci.yml", import.meta.url),
	"utf8",
);

describe("startup migration CI contract", () => {
	it("keeps the local-onboarding bootstrap owner aligned with its Basic username", () => {
		const onboardingEnv =
			workflow.split("\n  local-onboarding:\n")[1]?.split("\n    steps:\n")[0] ??
			"";
		const username = onboardingEnv.match(/^      UI_USERNAME: (\S+)$/m)?.[1];
		const owner = onboardingEnv.match(
			/^      GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: (\S+)$/m,
		)?.[1];
		expect(username).toBeTruthy();
		expect(owner).toBe(username);
	});

	it("verifies both stores after application startup and API restart", () => {
		expect(workflow).toContain(
		"Verify startup migrations are complete after application boot and restart",
	);
		expect(workflow).toContain("SELECT count(*) FROM pgmigrations");
		expect(workflow).toContain(
		"SELECT count() FROM glasshouse_schema_migrations",
	);
		expect(workflow).toContain("restart api");
		expect(workflow).toMatch(
			/up --detach --no-deps --wait(?: --wait-timeout 180)? api/,
		);
	});
});
