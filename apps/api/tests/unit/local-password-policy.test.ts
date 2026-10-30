import { describe, expect, it } from "bun:test";
import { validNewLocalPassword } from "../../src/lib/local-passwords.js";

describe("new local password policy", () => {
	it("requires 12 characters without changing the UTF-8 byte ceiling", () => {
		expect(validNewLocalPassword("short-password")).toBe(true);
		expect(validNewLocalPassword("12345678901")).toBe(false);
		expect(validNewLocalPassword("123456789012")).toBe(true);
		expect(validNewLocalPassword("😀".repeat(11))).toBe(false);
		expect(validNewLocalPassword("😀".repeat(12))).toBe(true);
		expect(validNewLocalPassword("😀".repeat(256))).toBe(true);
		expect(validNewLocalPassword("😀".repeat(257))).toBe(false);
		expect(validNewLocalPassword("a".repeat(1024))).toBe(true);
		expect(validNewLocalPassword("a".repeat(1025))).toBe(false);
	});
});
