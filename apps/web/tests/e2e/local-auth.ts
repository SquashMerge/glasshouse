import type { Page } from "@playwright/test";

export const LOCAL_USER = process.env.E2E_LOCAL_USERNAME ?? "e2e-local-admin";

export async function fillLocalPassword(page: Page) {
	const password = process.env.E2E_LOCAL_PASSWORD;
	if (!password) throw new Error("E2E_LOCAL_PASSWORD must be configured");
	// Locator.fill includes its argument in failure call logs and reports.
	await page.getByLabel(/Password/i).evaluate((element, value) => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!;
		setter.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	}, password);
}
