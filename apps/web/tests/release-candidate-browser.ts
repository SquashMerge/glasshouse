import { chromium, expect } from "@playwright/test";

const baseURL = process.env.CANDIDATE_URL;
if (!baseURL || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(baseURL)) {
	throw new Error("A loopback candidate URL is required");
}

const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	// Long-lived requests need not settle; the assertions below define UI readiness.
	await page.goto(baseURL, { waitUntil: "domcontentloaded" });
	await expect(page).toHaveTitle("Glasshouse by SquashMerge");
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
	await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
	const status = await page.evaluate(async () => {
		const anonymous = await fetch("/v1/projects");
		const authenticated = await fetch("/v1/projects", {
			headers: {
				Authorization: `Basic ${btoa("synthetic-owner:synthetic-ui-9b412e8cfa")}`,
			},
		});
		const body = await authenticated.json();
		return {
			anonymous: anonymous.status,
			authenticated: authenticated.status,
			defaultProject: body.items?.some(
				(item: { slug: string }) => item.slug === "default",
			),
		};
	});
	expect(status).toEqual({
		anonymous: 401,
		authenticated: 200,
		defaultProject: true,
	});
	expect(errors).toEqual([]);
} finally {
	await browser.close();
}
