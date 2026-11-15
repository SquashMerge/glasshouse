import { defineConfig, devices } from "@playwright/test";

const E2E = process.env.PLAYWRIGHT_E2E === "true";
const ONBOARDING = process.env.PLAYWRIGHT_LOCAL_ONBOARDING === "true";
const RELEASE = process.env.PLAYWRIGHT_RELEASE_IMAGE === "true";
if (E2E || ONBOARDING || RELEASE) process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
	testDir: "./tests",
	testMatch: RELEASE
		? ["tests/e2e/release-image.spec.ts"]
		: ONBOARDING
			? ["tests/e2e/local-onboarding.spec.ts"]
			: E2E
				? ["tests/e2e/**/*.spec.ts"]
				: ["tests/smoke.spec.ts"],
	testIgnore: RELEASE
		? []
		: [
				"**/release-image.spec.ts",
				...(ONBOARDING ? [] : ["**/local-onboarding.spec.ts"]),
			],
	fullyParallel: true,
	workers: E2E || ONBOARDING || RELEASE ? 1 : undefined,
	forbidOnly: !!process.env.CI,
	retries: !ONBOARDING && !RELEASE && process.env.CI ? 2 : 0,
	reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: RELEASE ? "https://127.0.0.1:34763" : "http://localhost:5173",
		ignoreHTTPSErrors: RELEASE,
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
