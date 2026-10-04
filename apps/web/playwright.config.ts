import { defineConfig, devices } from "@playwright/test";

const E2E = process.env.PLAYWRIGHT_E2E === "true";
if (E2E) process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: "./tests",
  testMatch: E2E ? ["tests/e2e/**/*.spec.ts"] : ["tests/smoke.spec.ts"],
  fullyParallel: true,
  workers: E2E ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL: "http://localhost:5173",
    // E2E auth requests/cookies and DOM password values must not enter artifacts.
    trace: E2E ? "off" : "on-first-retry",
    screenshot: E2E ? "off" : "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
