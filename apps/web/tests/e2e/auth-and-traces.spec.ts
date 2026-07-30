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

	test("unauthenticated /observability/traces/{32-hex} redirects to /login", async ({
		page,
	}) => {
		await gotoFresh(
			page,
			"/observability/traces/0123456789abcdef0123456789abcdef",
		);
		await expect(page).toHaveURL(/\/login$/);
	});

	test("wrong credentials show inline error and stay on /login", async ({
		page,
	}) => {
		await gotoFresh(page, "/login");
		await page.getByLabel(/Username/i).fill(USER);
		await page.getByLabel(/Password/i).fill("wrongpassword");
		await page.getByRole("button", { name: /Sign in/i }).click();
		await expect(page.getByRole("alert")).toContainText(
			/Login failed|Invalid credentials/i,
		);
		await expect(page).toHaveURL(/\/login$/);
	});

	test("correct credentials redirect to / without persisting them in storage", async ({
		page,
	}) => {
		await gotoFresh(page, "/login");
		await page.getByLabel(/Username/i).fill(USER);
		await page.getByLabel(/Password/i).fill(PASS);
		await page.getByRole("button", { name: /Sign in/i }).click();
		await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });
		const stored = await page.evaluate(() => ({
			u: window.localStorage.getItem("astraea.auth.username"),
			p: window.localStorage.getItem("astraea.auth.password"),
		}));
		expect(stored.u).toBeNull();
		expect(stored.p).toBeNull();
	});

	test("logout clears in-memory credentials and routes to /login", async ({
		page,
	}) => {
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
	test("renders the trace list with shadcn table primitives", async ({
		page,
	}) => {
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
			await expect(
				page.getByRole("columnheader", { name: /Time/i }),
			).toBeVisible();
			await expect(
				page.getByRole("columnheader", { name: /Name/i }),
			).toBeVisible();
			await expect(
				page.getByRole("columnheader", { name: /Status/i }),
			).toBeVisible();
		}
	});
});

test.describe("Shared app workspace", () => {
	test("keeps all product routes full-width on desktop and usable on narrow screens", async ({
		page,
	}) => {
		test.setTimeout(90_000);
		await gotoFresh(page, "/login");
		await page.getByLabel(/Username/i).fill(USER);
		await page.getByLabel(/Password/i).fill(PASS);
		await page.getByRole("button", { name: /Sign in/i }).click();
		await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

		const routes = [
			"/",
			"/observability?tab=traces",
			"/observability?tab=spans",
			"/prompts",
			"/datasets",
			"/evaluations",
			"/feedback",
		];
		const viewports = [
			{ width: 1920, height: 1080 },
			{ width: 375, height: 812 },
		];

		for (const viewport of viewports) {
			await page.setViewportSize(viewport);

			for (const route of routes) {
				await page.goto(route);
				const workspace = page.locator("main.flex-1 > div[data-hydrated='1']");
				await expect(workspace).toBeVisible();
				await expect(workspace).toHaveClass(/(^|\s)max-w-none(\s|$)/);

				const bounds = await workspace.boundingBox();
				expect(bounds).not.toBeNull();
				expect(bounds!.x).toBeGreaterThanOrEqual(0);
				expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
					viewport.width + 1,
				);

				if (viewport.width === 1920) {
					expect(bounds!.width).toBeGreaterThan(1600);
				}
			}
		}
	});

	test("uses the available main-pane width below the old desktop cap", async ({
		page,
	}) => {
		await gotoFresh(page, "/login");
		await page.getByLabel(/Username/i).fill(USER);
		await page.getByLabel(/Password/i).fill(PASS);
		await page.getByRole("button", { name: /Sign in/i }).click();
		await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

		for (const viewport of [
			{ width: 1440, height: 900 },
			{ width: 1024, height: 768 },
		]) {
			await page.setViewportSize(viewport);
			await page.goto("/");
			const workspace = page.locator("main.flex-1 > div[data-hydrated='1']");
			await expect(workspace).toBeVisible();
			const bounds = await workspace.boundingBox();
			expect(bounds).not.toBeNull();
			expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
			expect(bounds!.width).toBeGreaterThan(viewport.width - 260);
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
	test("dashboard renders with zero console errors during load", async ({
		page,
	}) => {
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

		await expect(page.getByText("Astraea", { exact: true })).toBeVisible();
		expect(errors, `console errors observed: ${errors.join("\n")}`).toEqual([]);
	});

	test("sidebar links to /observability", async ({ page }) => {
		await gotoFresh(page, "/login");
		await page.getByLabel(/Username/i).fill(USER);
		await page.getByLabel(/Password/i).fill(PASS);
		await page.getByRole("button", { name: /Sign in/i }).click();
		await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

		await page
			.getByRole("link", { name: /Observability/i })
			.first()
			.click();
		await expect(page).toHaveURL(/\/observability$/);
	});
});
