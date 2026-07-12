// Prereqs: `make deps-up`, then `make dev-backend` + `make dev-frontend` in separate
// terminals. UI_USERNAME / UI_PASSWORD come from infra/.env (see playwright.config).

import { test, expect, type Page } from "@playwright/test";

const USER = process.env.UI_USERNAME ?? "astraea";
const PASS = process.env.UI_PASSWORD ?? "testpassword";

async function gotoFresh(page: Page, path: string) {
  await page.context().clearCookies();
  // Navigate first so the page has a real document; localStorage is
  // not accessible on `about:blank` (Playwright raises a SecurityError).
  await page.goto(path);
  await page.evaluate(() => window.localStorage.clear());
}

test.describe("Login flow", () => {
  test("unauthenticated / redirects to /login", async ({ page }) => {
    await gotoFresh(page, "/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: /Sign in/i })).toBeVisible();
  });

  test("unauthenticated /observability/traces/{32-hex} redirects to /login", async ({ page }) => {
    await gotoFresh(page, "/observability/traces/0123456789abcdef0123456789abcdef");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("wrong credentials show inline error and stay on /login", async ({ page }) => {
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill("wrongpassword");
    await page.getByRole("button", { name: /Sign in/i }).click();
    await expect(page.getByRole("alert")).toContainText(/Login failed|Invalid credentials/i);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("correct credentials redirect to / and persist in localStorage", async ({ page }) => {
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill(PASS);
    await page.getByRole("button", { name: /Sign in/i }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });
    const stored = await page.evaluate(() => ({
      u: window.localStorage.getItem("astraea.auth.username"),
      p: window.localStorage.getItem("astraea.auth.password"),
    }));
    expect(stored.u).toBe(USER);
    expect(stored.p).toBe(PASS);
  });

  test("logout clears localStorage and routes to /login", async ({ page }) => {
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill(PASS);
    await page.getByRole("button", { name: /Sign in/i }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

    await page.getByRole("button", { name: USER }).click();
    await page.getByRole("menuitem", { name: /Log out/i }).click();
    await page.waitForURL(/\/login$/, { timeout: 5000 });

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
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill(PASS);
    await page.getByRole("button", { name: /Sign in/i }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

    await page.goto("/observability?tab=traces");
    const table = page.locator("table");
    await expect(table).toBeVisible({ timeout: 5000 });
    const hasRows = await page.locator("tbody tr").count();
    if (hasRows === 0) {
      await expect(page.getByText(/No traces yet/i)).toBeVisible();
    } else {
      await expect(page.getByRole("columnheader", { name: /Time/i })).toBeVisible();
      await expect(page.getByRole("columnheader", { name: /Name/i })).toBeVisible();
      await expect(page.getByRole("columnheader", { name: /Status/i })).toBeVisible();
    }
  });
});

test.describe("Auth gate: 401 from API", () => {
  test("expired creds route to /login", async ({ page }) => {
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill("definitely-wrong-password");
    await page.getByRole("button", { name: /Sign in/i }).click();
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

    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill(PASS);
    await page.getByRole("button", { name: /Sign in/i }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

    await expect(page.getByRole("heading", { name: /Astraea/i })).toBeVisible();
    expect(errors, `console errors observed: ${errors.join("\n")}`).toEqual([]);
  });

  test("sidebar links to /observability", async ({ page }) => {
    await gotoFresh(page, "/login");
    await page.getByLabel(/Username/i).fill(USER);
    await page.getByLabel(/Password/i).fill(PASS);
    await page.getByRole("button", { name: /Sign in/i }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

    await page.getByRole("link", { name: /Observability/i }).click();
    await expect(page).toHaveURL(/\/observability$/);
  });
});