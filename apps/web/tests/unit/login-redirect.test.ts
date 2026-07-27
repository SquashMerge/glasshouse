import "./setup";
import { describe, expect, it } from "vitest";
import { safeRedirect } from "../../src/routes/login";

describe("safeRedirect", () => {
	it("does not send a successful login back to the login route", () => {
		expect(
			safeRedirect("/login?redirect=%2Flogin%3Fredirect%3D%252Fprompts"),
		).toBe("/");
	});

	it("preserves a valid protected route", () => {
		expect(safeRedirect("/prompts/my-prompt?tab=versions")).toBe(
			"/prompts/my-prompt?tab=versions",
		);
	});
});
