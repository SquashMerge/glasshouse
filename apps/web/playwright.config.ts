import { defineConfig, devices } from "@playwright/test";

const E2E = process.env.PLAYWRIGHT_E2E === "true";
const ONBOARDING = process.env.PLAYWRIGHT_LOCAL_ONBOARDING === "true";
if (E2E || ONBOARDING) process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
	testDir: "./tests",
	testMatch: ONBOARDING
		? ["tests/e2e/local-onboarding.spec.ts"]
		: E2E
			? ["tests/e2e/**/*.spec.ts"]
			: ["tests/smoke.spec.ts"],
	testIgnore: ONBOARDING ? [] : ["**/local-onboarding.spec.ts"],
	fullyParallel: true,
	workers: E2E || ONBOARDING ? 1 : undefined,
	forbidOnly: !!process.env.CI,
	retries: !ONBOARDING && process.env.CI ? 2 : 0,
	reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: "http://localhost:5173",
		trace: "off",
		screenshot: "off",
		video: "off",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
