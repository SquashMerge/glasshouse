import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

let root: string;
let fetchApp: (request: Request) => Response | Promise<Response>;
beforeAll(async () => {
	root = await mkdtemp(join(process.cwd(), "node_modules", ".web-entry-test-"));
	await writeFile(join(root, "index.html"), "<html>Glasshouse</html>");
	fetchApp = (await import("../../src/index.js")).createServerFetch(root);
});
afterAll(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

test("configured entrypoint serves browser shell and still authenticates API", async () => {
	const shell = await fetchApp(
		new Request("http://localhost/login", { headers: { accept: "text/html" } }),
	);
	expect(shell.status).toBe(200);
	expect(await shell.text()).toContain("Glasshouse");
	const api = await fetchApp(new Request("http://localhost/v1/projects"));
	expect(api.status).toBe(401);
});
