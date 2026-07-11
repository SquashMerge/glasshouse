import { test, expect, type ConsoleMessage } from "@playwright/test";

test("dashboard renders with title, links, zero console errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err: Error) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });

  await page.goto("/", { waitUntil: "networkidle" });

  // Title
  await expect(page).toHaveTitle("Astraea · MVP Foundation");

  // Heading
  const h1 = page.locator("h1");
  await expect(h1).toContainText("Astraea");

  // Two outbound links: /reference and /health
  const referenceLink = page.locator('a[href="/reference"]');
  const healthLink = page.locator('a[href="/health"]');
  await expect(referenceLink).toBeVisible();
  await expect(healthLink).toBeVisible();

  // HealthBadge renders (even if /health is down — the component itself must mount)
  await expect(page.getByText(/postgres:/i)).toBeVisible();

  // Zero console errors during page load
  expect(consoleErrors, `console errors observed: ${consoleErrors.join("\n")}`).toEqual([]);
});