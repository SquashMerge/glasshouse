import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("a fresh release bundle provisions the first Admin and signs in", async ({
	page,
}) => {
	const file = process.env.RELEASE_SETUP_SECRET_FILE;
	if (!file) throw new Error("Release setup secret file is required");
	const token = (await readFile(file, "utf8")).trim();
	const password = "synthetic-browser-password";
	async function fillSecret(label: string, value: string) {
		await page
			.getByLabel(label, { exact: true })
			.evaluate((element, secret) => {
				const setter = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)!.set!;
				setter.call(element, secret);
				element.dispatchEvent(new Event("input", { bubbles: true }));
			}, value);
	}
	await page.goto("/");
	await page.waitForURL((url) => url.pathname === "/setup");
	await page.getByLabel("Username", { exact: true }).fill("release-admin");
	await fillSecret("Setup secret", token);
	await fillSecret("New password", password);
	await fillSecret("Confirm password", password);
	await page.getByRole("button", { name: "Create first Admin" }).click();
	await expect(page.getByText(/Your Admin account is ready/)).toBeVisible();
	await page.getByRole("link", { name: "Sign in" }).click();
	await page.getByLabel("Username", { exact: true }).fill("release-admin");
	await fillSecret("Password", password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.waitForURL((url) => url.pathname === "/");
	await expect(page.getByLabel("Primary")).toBeVisible();
	const result = await page.evaluate(async () => {
		const response = await fetch("/v1/projects");
		return { status: response.status, body: await response.json() };
	});
	expect(result.status).toBe(200);
	expect(
		result.body.items.some(
			(project: { slug: string }) => project.slug === "default",
		),
	).toBe(true);
	const cookies = await page.context().cookies();
	expect(
		cookies.some(
			(cookie) =>
				cookie.name === "glasshouse_session" &&
				cookie.httpOnly &&
				cookie.secure,
		),
	).toBe(true);
});
