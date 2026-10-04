import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";

// Auth journeys intentionally produce no secret-bearing trace, screenshot,
// video, HAR, storage-state or attachment artifacts, even on failure.
test.use({ trace: "off", screenshot: "off", video: "off" });
const USER = process.env.UI_USERNAME ?? "test.admin";
const PASS = process.env.UI_PASSWORD ?? "test-only-browser-password";

async function fillSecret(page: Page, label: string, value: string) {
	// Locator.fill exposes its argument in failure call logs.
	await page.getByLabel(label, { exact: true }).evaluate((element, secret) => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!;
		setter.call(element, secret);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	}, value);
}

async function signIn(page: Page, username = USER, password = PASS) {
	await page.goto("/login");
	await page.getByLabel("Username", { exact: true }).fill(username);
	await fillSecret(page, "Password", password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.waitForURL((url) => url.pathname === "/");
}
async function logout(page: Page) {
	await page.getByRole("button", { name: /Account menu/ }).click();
	await page.getByRole("menuitem", { name: "Log out" }).click();
	await page.waitForURL((url) => url.pathname === "/login");
}
async function noSecretStorage(page: Page) {
	const safe = await page.evaluate(() => {
		const keys = Object.keys(localStorage).concat(Object.keys(sessionStorage));
		return !keys.some((key) =>
			/auth|password|token|enrollment|secret/i.test(key),
		);
	});
	expect(safe).toBe(true);
}
async function noHorizontalOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
}

test("fresh setup, one-time handoff, login/logout and Admin management work at desktop and mobile widths", async ({
	page,
	browser,
}) => {
	test.setTimeout(120000);
	const file = process.env.E2E_SETUP_SECRET_FILE;
	if (!file)
		throw new Error(
			"A fresh, operator-provisioned CI setup fixture is required",
		);
	const token = await readFile(file, "utf8");
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto("/");
	await page.waitForURL((url) => url.pathname === "/setup");
	await expect(
		page.getByRole("heading", { name: "Set up Astraea" }),
	).toBeVisible();
	await noHorizontalOverflow(page);
	await page.getByLabel("Username", { exact: true }).focus();
	await page.keyboard.press("Tab");
	await expect(page.getByLabel("Setup secret")).toBeFocused();
	await page.getByLabel("Username", { exact: true }).fill(USER);
	await fillSecret(page, "Setup secret", token);
	await fillSecret(page, "New password", PASS);
	await fillSecret(page, "Confirm password", PASS);
	await page.getByRole("button", { name: "Create first Admin" }).click();
	await expect(page.getByText(/Your Admin account is ready/)).toBeVisible();
	await noSecretStorage(page);
	await page.reload();
	await expect(
		page.getByText(/unavailable or already initialized/),
	).toBeVisible();
	await expect(page.getByLabel("Setup secret")).toHaveCount(0);
	await signIn(page);
	await page.reload();
	await expect(page.getByLabel("Primary")).toBeVisible();
	const cookieProperties = (await page.context().cookies())
		.filter((cookie) => cookie.name === "astraea_session")
		.map(({ httpOnly, sameSite, path }) => ({ httpOnly, sameSite, path }));
	expect(cookieProperties).toEqual([
		{ httpOnly: true, sameSite: "Strict", path: "/v1" },
	]);
	await page.goto("/access");
	await page.getByRole("button", { name: `Disable ${USER}` }).click();
	await page
		.getByRole("button", { name: "Confirm disable", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText(
		/another enrolled, enabled Admin/,
	);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	const username = "onboard.user";
	await page.getByLabel("New username").fill(username);
	await page
		.getByLabel("Organization role", { exact: true })
		.selectOption("user");
	await page
		.getByRole("button", { name: "Provision account", exact: true })
		.click();
	const handoff = page.getByLabel("Enrollment code (shown once)");
	await expect(handoff).toBeFocused();
	const code = await handoff.inputValue();
	await noSecretStorage(page);
	await noHorizontalOverflow(page);
	await page.getByRole("button", { name: /handed off the code/ }).click();
	await expect(handoff).toHaveCount(0);
	await page.reload();
	await expect(handoff).toHaveCount(0);
	await page
		.getByLabel(`Role for ${username}`, { exact: true })
		.selectOption("read_only");
	await expect(
		page.getByLabel(`Role for ${username}`, { exact: true }),
	).toHaveValue("read_only");
	const userContext = await browser.newContext({
		baseURL: "http://localhost:5173",
		viewport: { width: 375, height: 812 },
	});
	const user = await userContext.newPage();
	try {
		await user.goto("http://localhost:5173/enroll");
		await fillSecret(user, "Enrollment code", code);
		await fillSecret(user, "New password", PASS);
		await fillSecret(user, "Confirm password", PASS);
		await user
			.getByRole("button", { name: "Set password", exact: true })
			.click();
		await expect(user.getByText(/Your password is set/)).toBeVisible();
		await signIn(user, username);
		await noSecretStorage(user);
		await user.goto("http://localhost:5173/access");
		await expect(user.getByText(/restricted to Admins/)).toBeVisible();
		await page
			.getByRole("button", { name: `Disable ${username}`, exact: true })
			.click();
		await page
			.getByRole("button", { name: "Confirm disable", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: `Enable ${username}`, exact: true }),
		).toBeVisible();
		await user.reload();
		await user.waitForURL((url) => url.pathname === "/login");
		await page
			.getByRole("button", { name: `Enable ${username}`, exact: true })
			.click();
		await page
			.getByRole("button", { name: `Re-enroll ${username}`, exact: true })
			.click();
		await page
			.getByRole("button", { name: "Confirm re-enrollment", exact: true })
			.click();
		await expect(handoff).toBeFocused();
		await page.getByRole("button", { name: /handed off the code/ }).click();
		await page
			.getByRole("button", {
				name: `Revoke enrollment for ${username}`,
				exact: true,
			})
			.click();
		await expect(page.getByText(/^revoked/).first()).toBeVisible();
	} finally {
		await userContext.close();
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	for (const path of [
		"/",
		"/feedback",
		"/evaluations",
		"/datasets",
		"/access",
	]) {
		await page.goto(path);
		await expect(page.getByLabel("Primary")).toBeVisible();
		await noHorizontalOverflow(page);
	}
	await logout(page);
	await page.goto("/");
	await page.waitForURL((url) => url.pathname === "/login");
	await noSecretStorage(page);
});
