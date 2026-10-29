import { test } from "@playwright/test";
import { assertSignedOutAppFlow } from "./smoke-flow";

test("the signed-out app opens the current sign-in flow", async ({ page }) => {
	await assertSignedOutAppFlow(page);
});
