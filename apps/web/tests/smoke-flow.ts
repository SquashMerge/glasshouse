import { expect, type Page } from "@playwright/test";

export async function assertSignedOutAppFlow(page: Page) {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/v1/auth/session", (route) =>
		route.fulfill({
			status: 401,
			json: { code: "UNAUTHORIZED", message: "Authentication required" },
		}),
	);
	await page.route("**/v1/auth/setup", (route) =>
		route.fulfill({ json: { available: false } }),
	);
	await page.goto("/");

	await expect(page).toHaveTitle("Glasshouse by SquashMerge");
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Username" })).toBeVisible();
	await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
	await expect(
		page.getByRole("heading", { name: "Organization overview" }),
	).toHaveCount(0);
	expect(pageErrors).toEqual([]);
}
