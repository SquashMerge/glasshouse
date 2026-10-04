import { expect, test, type Page } from "@playwright/test";
import { LOCAL_USER, fillLocalPassword } from "./local-auth";

async function login(page: Page) {
	await page.goto("/login");
	await page.getByLabel(/Username/i).fill(LOCAL_USER);
	await fillLocalPassword(page);
	await page.getByRole("button", { name: /Sign in/i }).click();
	await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });
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

test("lists and creates a prompt through the dashboard", async ({ page }) => {
	await login(page);
	await page.getByRole("link", { name: /Prompts/i }).click();
	await expect(page).toHaveURL(/\/prompts$/);
	await expect(page.getByTestId("prompts-page")).toBeVisible();
	await expect(page.getByTestId("prompts-empty")).toContainText(
		"No prompts yet",
	);

	await page.getByRole("link", { name: "New prompt" }).click();
	await page.getByLabel("Name").fill("CI Prompt");
	await page.getByTestId("save-prompt").click();
	await expect(page.getByRole("alert")).toContainText(
		"Enter a system or user prompt.",
	);

	await page.getByLabel(/System prompt/i).fill("You are the CI assistant.");
	await page.getByTestId("save-prompt").click();
	await page.waitForURL(/\/prompts\/ci-prompt$/, { timeout: 5000 });
	await expect(page.getByTestId("prompt-detail")).toContainText("CI Prompt");
	await expect(page.getByTestId("prompt-message-system")).toHaveText(
		"You are the CI assistant.",
	);

	await page.getByRole("link", { name: /Prompts/i }).click();
	await expect(
		page.getByRole("list", { name: "Project prompts" }),
	).toContainText("CI Prompt");
});
