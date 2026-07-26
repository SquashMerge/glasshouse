import { describe, expect, it, vi } from "vitest";
import { copyJson, copyText } from "../../src/lib/clipboard";

describe("clipboard", () => {
	it("copies supplied text verbatim, including redactions", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);

		await expect(copyText("[REDACTED]", { writeText })).resolves.toEqual({
			ok: true,
		});
		expect(writeText).toHaveBeenCalledWith("[REDACTED]");
	});

	it("returns failures without logging or throwing", async () => {
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const writeText = vi.fn().mockRejectedValue(new Error("denied"));

		await expect(copyText("secret", { writeText })).resolves.toEqual({
			ok: false,
			error: "failed",
		});
		await expect(copyText("secret", null)).resolves.toEqual({
			ok: false,
			error: "unavailable",
		});
		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("returns a failure for non-serializable JSON", async () => {
		const value: { self?: unknown } = {};
		value.self = value;

		await expect(copyJson(value, { writeText: vi.fn() })).resolves.toEqual({
			ok: false,
			error: "failed",
		});
	});
});
