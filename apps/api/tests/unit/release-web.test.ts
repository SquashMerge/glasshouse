import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { releaseWeb } from "../../src/middleware/release-web";

let directory: string;
const app = new Hono();
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "glasshouse-web-test-"));
	await mkdir(join(directory, "assets"));
	await writeFile(join(directory, "index.html"), "<html>Glasshouse UI</html>");
	await writeFile(join(directory, "assets", "app.js"), "console.log('ui')");
	app.use(releaseWeb(directory));
	app.all("*", (c) => c.text("API", 401));
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("single image web", () => {
	it("integrates web serving without weakening the actual API authentication", async () => {
		process.env.UI_USERNAME ??= "test-user";
		process.env.UI_PASSWORD ??= "test-password";
		const { createApiApp } = await import("../../src/index");
		const api = createApiApp({ webDirectory: directory });
		const ui = await api.request("/setup");
		expect(ui.status).toBe(200);
		expect(await ui.text()).toContain("Glasshouse UI");
		const protectedApi = await api.request("/v1/projects");
		expect(protectedApi.status).toBe(401);
		expect(protectedApi.headers.get("content-security-policy")).toContain(
			"default-src 'none'",
		);
	});
	it("serves the application and SPA navigation with browser security headers", async () => {
		for (const path of ["/", "/observability", "/setup"]) {
			const response = await app.request(path);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("Glasshouse UI");
			expect(response.headers.get("content-security-policy")).toContain(
				"default-src 'self'",
			);
		}
	});
	it("serves existing static assets, but never falls back for missing assets", async () => {
		expect(
			(await app.request("/assets/app.js")).headers.get("content-type"),
		).toContain("javascript");
		expect((await app.request("/assets/missing.js")).status).toBe(404);
	});
	it("never intercepts API, health, reference, or non-GET requests", async () => {
		for (const [path, method] of [
			["/v1/projects", "GET"],
			["/v1", "GET"],
			["/health", "GET"],
			["/reference", "GET"],
			["/openapi.json", "GET"],
			["/setup", "POST"],
		]) {
			const response = await app.request(path, { method });
			expect(response.status).toBe(401);
			expect(await response.text()).toBe("API");
		}
	});
});
