import { defineConfig, devices } from "@playwright/test";

const E2E = process.env.PLAYWRIGHT_E2E === "true";

export default defineConfig({
  testDir: "./tests",
  testMatch: E2E ? ["tests/e2e/**/*.spec.ts"] : ["tests/smoke.spec.ts"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
