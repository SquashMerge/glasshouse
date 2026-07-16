import { describe, it, expect } from "vitest";
import { cn } from "../../src/lib/utils";

describe("cn", () => {
	it("joins truthy class names with a single space", () => {
		expect(cn("a", "b", "c")).toBe("a b c");
	});

	it("drops falsy values", () => {
		expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
	});

	it("returns empty string when all values are falsy", () => {
		expect(cn(false, null, undefined, "")).toBe("");
	});

	it("preserves order", () => {
		expect(cn("z", "a", "m")).toBe("z a m");
	});
});
