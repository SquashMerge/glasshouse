import { describe, expect, it } from "bun:test";
import { validLocalPassword } from "../../src/lib/local-passwords.js";

describe("local password policy", () => {
	it("requires 12 Unicode code points and limits passwords to 1024 UTF-8 bytes", () => {
		expect(validLocalPassword("short-password")).toBe(true);
		expect(validLocalPassword("12345678901")).toBe(false);
		expect(validLocalPassword("123456789012")).toBe(true);
		expect(validLocalPassword("😀".repeat(11))).toBe(false);
		expect(validLocalPassword("😀".repeat(12))).toBe(true);
		expect(validLocalPassword("😀".repeat(256))).toBe(true);
		expect(validLocalPassword("😀".repeat(257))).toBe(false);
		expect(validLocalPassword("a".repeat(1024))).toBe(true);
		expect(validLocalPassword("a".repeat(1025))).toBe(false);
	});
});
