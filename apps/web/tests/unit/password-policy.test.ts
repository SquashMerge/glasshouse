import { describe, expect, it } from "vitest";
import { getNewPasswordValidationError } from "../../src/lib/password-policy";

describe("new password guidance", () => {
	it("counts characters rather than UTF-16 code units and preserves the size limit", () => {
		expect(getNewPasswordValidationError("12345678901")).toMatch(
			/12 characters/,
		);
		expect(getNewPasswordValidationError("123456789012")).toBeNull();
		expect(getNewPasswordValidationError("😀".repeat(12))).toBeNull();
		expect(getNewPasswordValidationError("😀".repeat(256))).toBeNull();
		expect(getNewPasswordValidationError("😀".repeat(257))).toMatch(/shorter/);
	});
});
