import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const globalStyles = readFileSync(
	resolve(process.cwd(), "src/styles/globals.css"),
	"utf8",
);

describe("interactive cursor styles", () => {
	it("uses a pointer cursor for enabled buttons", () => {
		expect(globalStyles).toMatch(
			/button:not\(:disabled\)\s*\{\s*cursor:\s*pointer;/,
		);
	});
});
