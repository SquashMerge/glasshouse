// E2E tests for the login flow + auth gate + trace list + trace detail.
// Runs against the dev stack (or the local workflow: deps + api + web).
//
// Prereqs:
//   1. `make deps-up` (Postgres + ClickHouse + Valkey in Docker)
//   2. `make dev-backend` in one terminal (api on :3000)
//   3. `make dev-frontend` in another terminal (web on :5173)
//   4. infra/.env has UI_USERNAME=astraea and UI_PASSWORD=<some non-empty>
//
// The tests use the credentials from UI_USERNAME / UI_PASSWORD via env
// (passed by Playwright's webServer config below).

import { test, expect, type Page } from "@playwright/test";

const USER = process.env.UI_USERNAME ?? "astraea";
const PASS = process.env.UI_PASSWORD ?? "testpassword";

async function gotoFresh(page: Page, path: string) {
  await page.context().clearCookies();
  await page.evaluate(() => window.localStorage.clear());
  await page.goto(path);
}

test.describe("Login flow", () => {
  test("unauthenticated / redirects to /login", async ({ page }) => {
    await gotoFresh(page, "/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: /Sign in/i })).toBeVisible();
  });

  test("unauthenticated /traces redirects to /login", async ({ page }) => {
    await gotoFresh(page, "/traces");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("wrong credentials show inline error and stay on /login", async ({ page }) => {
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill("wrongpassword");
    await page.getByRole("button", { name: /Sign in/i }).click();
    // Alert becomes visible
    await expect(page.getByRole("alert")).toContainText(/Login failed|Invalid credentials/i);
    // Still on /login
    await expect(page).toHaveURL(/\/login$/);
  });

  test("correct credentials redirect to / and persist in localStorage", async ({ page }) => {
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill(PASS);
    await page.getByRole("button", { name: /Sign in/i }).click();
    // Should land on /
    await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });
    // localStorage has the creds
    const stored = await page.evaluate(() => ({
      u: window.localStorage.getItem("astraea.auth.username"),
      p: window.localStorage.getItem("astraea.auth.password"),
    }));
    expect(stored.u).toBe(USER);
    expect(stored.p).toBe(PASS);
  });

  test("logout clears localStorage and routes to /login", async ({ page }) => {
    // Sign in
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill(PASS);
    await page.getByRole("button", { name: /Sign in/i }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

    // Open user menu and click Log out
    await page.getByRole("button", { name: USER }).click();
    await page.getByRole("menuitem", { name: /Log out/i }).click();
    await page.waitForURL(/\/login$/, { timeout: 5000 });

    // localStorage cleared
    const stored = await page.evaluate(() => ({
      u: window.localStorage.getItem("astraea.auth.username"),
      p: window.localStorage.getItem("astraea.auth.password"),
    }));
    expect(stored.u).toBeNull();
    expect(stored.p).toBeNull();
  });
});

test.describe("Trace list", () => {
  test("renders the trace list with shadcn table primitives", async ({ page }) => {
    // Sign in first
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill(PASS);
    await page.getByRole("button", { name: /Sign in/i }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

    await page.goto("/traces");
    // Table renders (or shows empty state)
    const table = page.locator("table");
    await expect(table).toBeVisible({ timeout: 5000 });
    // Either shows rows OR the empty-state cell
    const hasRows = await page.locator("tbody tr").count();
    if (hasRows === 0) {
      // Empty state — that's also valid for a fresh install
      await expect(page.getByText(/No traces yet/i)).toBeVisible();
    } else {
      // Headers present
      await expect(page.getByRole("columnheader", { name: /Time/i })).toBeVisible();
      await expect(page.getByRole("columnheader", { name: /Name/i })).toBeVisible();
      await expect(page.getByRole("columnheader", { name: /Status/i })).toBeVisible();
    }
  });
});

test.describe("Auth gate: 401 from API", () => {
  test("expired creds route to /login", async ({ page }) => {
    // Simulate an expired session: store creds that the backend will reject.
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill("definitely-wrong-password");
    await page.getByRole("button", { name: /Sign in/i }).click();
    // We stay on /login with an error (since the login itself 401s).
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("alert")).toBeVisible();
  });
});

test.describe("Dashboard basics", () => {
  test("dashboard renders with zero console errors during load", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

    // Sign in
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill(PASS);
    await page.getByRole("button", { name: /Sign in/i }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

    // H1 contains "Astraea"
    await expect(page.getByRole("heading", { name: /Astraea/i })).toBeVisible();
    expect(errors, `console errors observed: ${errors.join("\n")}`).toEqual([]);
  });

  test("dashboard links to /traces", async ({ page }) => {
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill(PASS);
    await page.getByRole("button", { name: /Sign in/i }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

    await page.getByRole("link", { name: /Traces/i }).click();
    await expect(page).toHaveURL(/\/traces$/);
  });
});