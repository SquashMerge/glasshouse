import { test, expect, type Page } from "@playwright/test";
import { LOCAL_USER as USER, fillLocalPassword } from "./local-auth";

async function gotoFresh(page: Page, path: string) {
	await page.context().clearCookies();
	// Navigate first so the page has a real document; localStorage is
	// not accessible on `about:blank` (Playwright raises a SecurityError).
	await page.goto(path);
	await page.evaluate(() => window.localStorage.clear());
}

async function selectAccessibleProject(page: Page) {
	const selector = page.getByTestId("project-selector");
	await expect(selector).toBeVisible();
	const projectId = await selector
		.locator("option")
		.nth(1)
		.getAttribute("value");
	if (!projectId) throw new Error("Expected an accessible Project fixture");
	await selector.selectOption(projectId);
	await expect(selector).toHaveValue(projectId);
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
		await fillLocalPassword(page);
		const loginResponse = page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/v1/auth/login",
		);
		await page.getByRole("button", { name: /Sign in/i }).click();
		const login = await loginResponse;
		expect(login.status()).toBe(200);
		expect(Boolean(login.request().headers().authorization)).toBe(false);
		expect(Object.keys(login.request().postDataJSON()).sort()).toEqual([
			"password",
			"username",
		]);
		await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });
		const session = await page.evaluate(async () => {
			const response = await fetch("/v1/auth/session");
			const body = await response.json();
			return { status: response.status, authentication: body.authentication };
		});
		expect(session).toEqual({ status: 200, authentication: "local_session" });
		expect(
			(await page.context().cookies()).some(
				(cookie) =>
					cookie.name === "astraea_session" &&
					cookie.httpOnly &&
					cookie.sameSite === "Strict" &&
					cookie.path === "/v1",
			),
		).toBe(true);
		const stored = await page.evaluate(() => ({
			u: window.localStorage.getItem("astraea.auth.username"),
			p: window.localStorage.getItem("astraea.auth.password"),
			su: window.sessionStorage.getItem("astraea.auth.username"),
			sp: window.sessionStorage.getItem("astraea.auth.password"),
		}));
		expect(stored.u).toBeNull();
		expect(stored.p).toBeNull();
		expect(stored.su).toBeNull();
		expect(stored.sp).toBeNull();
		await page.reload();
		await expect(
			page.getByText("Operations overview", { exact: true }),
		).toBeVisible();
	});

	test("logout clears in-memory credentials and routes to /login", async ({
		page,
	}) => {
		await gotoFresh(page, "/login");
		await page.getByLabel(/Username/i).fill(USER);
		await fillLocalPassword(page);
		await page.getByRole("button", { name: /Sign in/i }).click();
		await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

		await page.getByRole("button", { name: USER }).click();
		await page.getByRole("menuitem", { name: /Log out/i }).click();
		await page.waitForURL(/\/login$/, { timeout: 5000 });
		expect(
			(await page.context().cookies()).some(
				(cookie) => cookie.name === "astraea_session",
			),
		).toBe(false);
		const status = await page.evaluate(
			async () => (await fetch("/v1/auth/session")).status,
		);
		expect(status).toBe(401);

		const stored = await page.evaluate(() => ({
			u: window.localStorage.getItem("astraea.auth.username"),
			p: window.localStorage.getItem("astraea.auth.password"),
		}));
		expect(stored.u).toBeNull();
		expect(stored.p).toBeNull();
	});
});

test("direct API Basic compatibility remains separate from browser local sessions", async ({
	request,
}) => {
	const apiBase = process.env.E2E_API_BASE ?? "http://localhost:3000";
	const username = process.env.UI_USERNAME ?? "astraea";
	const password = process.env.UI_PASSWORD ?? "testpassword";
	const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
	const login = await request.post(`${apiBase}/v1/auth/login`, {
		headers: { authorization },
		data: {},
	});
	// Assert only safe scalars: failure output must never include cookie/header values.
	expect(login.status()).toBe(200);
	expect(Boolean(login.headers()["set-cookie"])).toBe(false);
	const session = await request.get(`${apiBase}/v1/auth/session`, {
		headers: { authorization },
	});
	expect(session.status()).toBe(200);
	const body = await session.json();
	expect(body.authentication).toBe("basic");
	expect(body.csrf_token).toBeNull();
	expect(body.expires_at).toBeNull();
	const projects = await request.get(`${apiBase}/v1/projects`, {
		headers: { authorization },
	});
	expect(projects.status()).toBe(200);
});

test.describe("Trace list", () => {
	test("renders the trace list with shadcn table primitives", async ({
		page,
	}) => {
		await gotoFresh(page, "/login");
		await page.getByLabel(/Username/i).fill(USER);
		await fillLocalPassword(page);
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
		test.setTimeout(120_000);
		await gotoFresh(page, "/login");
		await page.getByLabel(/Username/i).fill(USER);
		await fillLocalPassword(page);
		await page.getByRole("button", { name: /Sign in/i }).click();
		await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

		const routes = [
			{ path: "/", content: "Operations overview" },
			{
				path: "/observability?tab=traces",
				content: "Traces",
				hasWideTable: true,
			},
			{
				path: "/observability?tab=spans",
				content: "Spans",
				hasWideTable: true,
			},
			{ path: "/prompts", content: "Prompts" },
			{ path: "/datasets", content: "Datasets" },
			{ path: "/evaluations", content: "Evaluations" },
			{ path: "/feedback", content: "Feedback" },
		];
		const viewports = [
			{ width: 1920, height: 1080 },
			{ width: 1440, height: 900 },
			{ width: 1024, height: 768 },
			{ width: 375, height: 812 },
		];

		for (const viewport of viewports) {
			await page.setViewportSize(viewport);

			for (const route of routes) {
				await page.goto(route.path);
				const workspace = page.locator("main.flex-1 > div[data-hydrated='1']");
				await expect(workspace).toBeVisible();
				await expect(
					workspace.getByText(route.content, { exact: true }).first(),
				).toBeVisible();
				await expect(workspace).toHaveClass(/(^|\s)max-w-none(\s|$)/);

				const bounds = await workspace.boundingBox();
				expect(bounds).not.toBeNull();
				expect(bounds!.x).toBeGreaterThanOrEqual(0);
				expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
					viewport.width + 1,
				);
				expect(bounds!.x + bounds!.width).toBeGreaterThanOrEqual(
					viewport.width - 1,
				);

				if (viewport.width === 1920) {
					expect(bounds!.width).toBeGreaterThan(1600);
				}

				if (viewport.width === 375 && route.hasWideTable) {
					const tableViewport = page.locator("table").locator("..");
					const tableMetrics = await tableViewport.evaluate((element) => ({
						clientWidth: element.clientWidth,
						overflowX: getComputedStyle(element).overflowX,
						scrollWidth: element.scrollWidth,
					}));
					expect(tableMetrics.overflowX).toBe("auto");
					expect(tableMetrics.scrollWidth).toBeGreaterThan(
						tableMetrics.clientWidth,
					);
				}
			}
		}
	});

	test("uses the available main-pane width below the old desktop cap", async ({
		page,
	}) => {
		await gotoFresh(page, "/login");
		await page.getByLabel(/Username/i).fill(USER);
		await fillLocalPassword(page);
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

	test("keeps compact sidebar controls centered and project switching available", async ({
		page,
	}) => {
		await gotoFresh(page, "/login");
		await page.getByLabel(/Username/i).fill(USER);
		await fillLocalPassword(page);
		await page.getByRole("button", { name: /Sign in/i }).click();
		await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });
		await selectAccessibleProject(page);
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/");

		const sidebar = page.getByLabel("Primary");
		const home = sidebar.getByRole("link", { name: "Astraea home" });
		const projectControl = sidebar.getByRole("button", {
			name: /Current project: (?!No project selected).+\. Switch project/,
		});
		await expect(sidebar).toBeVisible();
		await expect(home.getByText("Astraea", { exact: true })).toBeHidden();
		await expect(projectControl).toBeVisible();

		const sidebarBounds = await sidebar.boundingBox();
		expect(sidebarBounds).not.toBeNull();
		for (const target of [
			home,
			projectControl,
			...[
				"Dashboard",
				"Datasets",
				"Evaluations",
				"Feedback",
				"Observability",
				"Prompts",
			].map((label) => sidebar.getByRole("link", { name: label })),
		]) {
			const bounds = await target.boundingBox();
			expect(bounds).not.toBeNull();
			expect(bounds!.width).toBe(36);
			expect(bounds!.height).toBe(36);
			expect(
				Math.abs(
					bounds!.x +
						bounds!.width / 2 -
						(sidebarBounds!.x + sidebarBounds!.width / 2),
				),
			).toBeLessThanOrEqual(1);
		}

		expect(
			await sidebar.evaluate(
				(element) => element.scrollWidth <= element.clientWidth,
			),
		).toBe(true);
		await projectControl.click();
		await expect(page.getByRole("menu")).toBeVisible();
		await expect(page.getByRole("menuitemradio").first()).toBeVisible();
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
		await fillLocalPassword(page);
		await page.getByRole("button", { name: /Sign in/i }).click();
		await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

		await expect(page.getByText("Astraea", { exact: true })).toBeVisible();
		expect(errors, `console errors observed: ${errors.join("\n")}`).toEqual([]);
	});

	test("sidebar links to /observability", async ({ page }) => {
		await gotoFresh(page, "/login");
		await page.getByLabel(/Username/i).fill(USER);
		await fillLocalPassword(page);
		await page.getByRole("button", { name: /Sign in/i }).click();
		await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });

		await page
			.getByRole("link", { name: /Observability/i })
			.first()
			.click();
		await expect(page).toHaveURL(/\/observability$/);
	});
});
