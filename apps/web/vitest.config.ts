// Vitest config for unit tests in apps/web.
// Uses jsdom (DOM environment) + @testing-library/react for component tests.

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    exclude: ["tests/smoke.spec.ts", "tests/e2e/**", "node_modules/**", "dist/**"],
    setupFiles: ["./tests/unit/setup.ts"],
  },
});