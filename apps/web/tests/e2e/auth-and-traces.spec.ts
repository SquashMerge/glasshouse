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
					cookie.name === "glasshouse_session" &&
					cookie.httpOnly &&
					cookie.sameSite === "Strict" &&
					cookie.path === "/v1",
			),
		).toBe(true);
		const stored = await page.evaluate(() => ({
			u: window.localStorage.getItem("glasshouse.auth.username"),
			p: window.localStorage.getItem("glasshouse.auth.password"),
			su: window.sessionStorage.getItem("glasshouse.auth.username"),
			sp: window.sessionStorage.getItem("glasshouse.auth.password"),
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

		await page
			.getByRole("button", { name: `Account menu for ${USER}` })
			.click();
		await page.getByRole("menuitem", { name: /Log out/i }).click();
		await page.waitForURL(/\/login$/, { timeout: 5000 });
		expect(
			(await page.context().cookies()).some(
				(cookie) => cookie.name === "glasshouse_session",
			),
		).toBe(false);
		const status = await page.evaluate(
			async () => (await fetch("/v1/auth/session")).status,
		);
		expect(status).toBe(401);

		const stored = await page.evaluate(() => ({
			u: window.localStorage.getItem("glasshouse.auth.username"),
			p: window.localStorage.getItem("glasshouse.auth.password"),
		}));
		expect(stored.u).toBeNull();
		expect(stored.p).toBeNull();
	});
});

test("direct API Basic compatibility remains separate from browser local sessions", async ({
	request,
}) => {
	const apiBase = process.env.E2E_API_BASE ?? "http://localhost:3000";
	const username = process.env.UI_USERNAME ?? "glasshouse";
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
			{ path: "/projects", content: "Projects" },
		];
		const viewports = [
			{ width: 3840, height: 2160 },
			{ width: 2560, height: 1440 },
			{ width: 1920, height: 1080 },
			{ width: 1440, height: 900 },
			{ width: 1280, height: 800 },
			{ width: 1024, height: 768 },
			{ width: 768, height: 1024 },
			{ width: 414, height: 896 },
			{ width: 375, height: 812 },
			{ width: 320, height: 640 },
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

				if (!route.hasWideTable && viewport.width <= 768) {
					const overflow = await page.evaluate(() => {
						const offenders = Array.from(
							document.querySelectorAll<HTMLElement>("body *"),
						).filter((element) => {
							const bounds = element.getBoundingClientRect();
							if (bounds.width === 0) return false;
							let parent = element.parentElement;
							while (parent && parent !== document.body) {
								const overflowX = getComputedStyle(parent).overflowX;
								if (["auto", "scroll", "hidden", "clip"].includes(overflowX))
									return false;
								parent = parent.parentElement;
							}
							return bounds.left < -1 || bounds.right > window.innerWidth + 1;
						});
						return offenders.slice(0, 5).map((element) => ({
							tag: element.tagName,
							className:
								typeof element.className === "string" ? element.className : "",
							left: Math.round(element.getBoundingClientRect().left),
							right: Math.round(element.getBoundingClientRect().right),
						}));
					});
					expect(
						overflow,
						`${route.path} overflows at ${viewport.width}px`,
					).toEqual([]);
				}

				if (viewport.width <= 375 && route.hasWideTable) {
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

		const sidebar = page.getByLabel("Primary");
		const desktopHome = sidebar.getByRole("link", { name: "Glasshouse home" });
		const desktopIcon = desktopHome.locator("img");
		await expect(desktopIcon).toBeVisible();
		await expect(
			desktopHome.getByText("Glasshouse", { exact: true }),
		).toHaveCount(0);
		await expect(desktopIcon).toHaveAttribute(
			"src",
			"/brand/glasshouse-icon.png",
		);
		await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
		await expect(desktopIcon).toBeVisible();
		const collapsedSidebarBounds = await sidebar.boundingBox();
		const collapsedIconBounds = await desktopIcon.boundingBox();
		expect(collapsedSidebarBounds).not.toBeNull();
		expect(collapsedIconBounds).not.toBeNull();
		expect(
			Math.abs(
				collapsedIconBounds!.x +
					collapsedIconBounds!.width / 2 -
					(collapsedSidebarBounds!.x + collapsedSidebarBounds!.width / 2),
			),
		).toBeLessThanOrEqual(2);
		await sidebar.getByRole("button", { name: "Expand sidebar" }).click();
		await expect(desktopIcon).toBeVisible();

		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/");

		const mobileSidebar = page.getByLabel("Primary");
		const home = mobileSidebar.getByRole("link", { name: "Glasshouse home" });
		const projectControl = mobileSidebar.getByRole("button", {
			name: /Current project: (?!No project selected).+\. Switch project/,
		});
		await expect(mobileSidebar).toBeVisible();
		const brandIcon = home.locator("img");
		await expect(brandIcon).toBeVisible();
		await expect(brandIcon).toHaveAttribute(
			"src",
			"/brand/glasshouse-icon.png",
		);
		await expect(home.getByText("Glasshouse", { exact: true })).toHaveCount(0);
		await expect(projectControl).toBeVisible();

		const sidebarBounds = await mobileSidebar.boundingBox();
		expect(sidebarBounds).not.toBeNull();
		const homeBounds = await home.boundingBox();
		expect(homeBounds).not.toBeNull();
		expect(homeBounds!.width).toBe(48);
		expect(homeBounds!.height).toBe(48);
		expect(
			Math.abs(
				homeBounds!.x +
					homeBounds!.width / 2 -
					(sidebarBounds!.x + sidebarBounds!.width / 2),
			),
		).toBeLessThanOrEqual(1);

		for (const target of [
			projectControl,
			...[
				"Dashboard",
				"Datasets",
				"Evaluations",
				"Feedback",
				"Observability",
				"Prompts",
			].map((label) => mobileSidebar.getByRole("link", { name: label })),
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
			await mobileSidebar.evaluate(
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

		const brandLogo = page.locator('img[src="/brand/glasshouse-icon.png"]');
		await expect(brandLogo).toBeVisible();
		expect(
			await brandLogo.evaluate((image: HTMLImageElement) => image.naturalWidth),
		).toBeGreaterThan(0);
		await expect(
			page
				.getByRole("link", { name: "Glasshouse home" })
				.getByText("Glasshouse", { exact: true }),
		).toHaveCount(0);
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
