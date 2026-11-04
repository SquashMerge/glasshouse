import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSingleImageFetch } from "../../src/lib/single-image-web.js";

let root: string;
let fetchApp: (request: Request) => Promise<Response>;
const request = (path: string, init?: RequestInit) =>
	fetchApp(new Request(`http://localhost${path}`, init));

beforeAll(async () => {
	root = await mkdtemp(join(process.cwd(), "node_modules", ".web-test-"));
	await mkdir(join(root, "assets"));
	await writeFile(join(root, "index.html"), "<html>Glasshouse</html>");
	await writeFile(join(root, "assets", "main.js"), "export default 1;");
	await symlink("/etc/passwd", join(root, "assets", "leak.txt"));
	fetchApp = createSingleImageFetch(
		root,
		async () =>
			new Response("api denied", {
				status: 401,
				headers: { "cache-control": "no-store" },
			}),
	);
});
afterAll(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

describe("single image web boundary", () => {
	test("serves the root shell without an Accept header", async () => {
		expect((await request("/")).status).toBe(200);
	});
	test("serves the shell for navigation with web security headers", async () => {
		const response = await request("/projects/example", {
			headers: { accept: "text/html" },
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Glasshouse");
		expect(response.headers.get("content-security-policy")).toContain(
			"default-src 'self'",
		);
		expect(response.headers.get("cache-control")).toBe("no-cache");
	});
	test("keeps API authentication and response headers untouched", async () => {
		for (const path of [
			"/v1/projects",
			"/v1/missing",
			"/health",
			"/openapi.json",
			"/reference",
		]) {
			const response = await request(path, {
				headers: { accept: "text/html" },
			});
			expect(response.status).toBe(401);
			expect(response.headers.get("cache-control")).toBe("no-store");
		}
	});
	test("passes API event streams through without buffering or rewriting headers", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
			},
		});
		const upstream = new Response(body, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-store",
				"x-accel-buffering": "no",
			},
		});
		const handler = createSingleImageFetch(root, () => upstream);
		const response = await handler(new Request("http://localhost/v1/events"));
		expect(response).toBe(upstream);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const reader = response.body!.getReader();
		controller.enqueue(new TextEncoder().encode("data: first\n\n"));
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			"data: first\n\n",
		);
		await reader.cancel();
	});
	test("serves assets but never falls back for missing assets or path escapes", async () => {
		expect((await request("/assets/main.js")).status).toBe(200);
		for (const path of [
			"/assets/missing.js",
			"/assets/leak.txt",
			"/assets/%2fetc%2fpasswd",
			"/assets/%252e%252e%252fsecret",
		]) {
			expect(
				(await request(path, { headers: { accept: "text/html" } })).status,
			).toBe(404);
		}
	});
	test("does not turn non-navigation requests or mutations into HTML", async () => {
		expect(
			(await request("/missing", { headers: { accept: "application/json" } }))
				.status,
		).toBe(404);
		expect((await request("/anything", { method: "POST" })).status).toBe(401);
	});
});
