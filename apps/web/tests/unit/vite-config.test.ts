import { describe, expect, it } from "vitest";
import viteConfig from "../../vite.config";

describe("Vite security headers", () => {
	it("allows the React dev preamble without weakening preview CSP", () => {
		const serverHeaders = viteConfig.server?.headers as Record<string, string>;
		const previewHeaders = viteConfig.preview?.headers as Record<
			string,
			string
		>;

		expect(serverHeaders["Content-Security-Policy"]).toContain(
			"script-src 'self' 'unsafe-inline'",
		);
		expect(previewHeaders["Content-Security-Policy"]).not.toContain(
			"script-src 'self' 'unsafe-inline'",
		);
	});
});
