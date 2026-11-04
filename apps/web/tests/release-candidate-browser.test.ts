import { expect, test } from "bun:test";

// Exercise the real candidate probe against a page that renders its login UI
// while a background response remains open. Network idleness is not readiness.
test("accepts a ready login UI while a background stream stays open", async () => {
	let streamOpened = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/stream") {
				streamOpened = true;
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(": connected\n\n"));
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			if (url.pathname === "/v1/projects") {
				return request.headers.has("authorization")
					? Response.json({ items: [{ slug: "default" }] })
					: new Response(null, { status: 401 });
			}
			return new Response(
				`<!doctype html><title>Glasshouse by SquashMerge</title>
				<script>
				fetch('/stream');
				setTimeout(() => { document.body.innerHTML = '<h1>Sign in</h1><label>Password<input type="password"></label>'; }, 100);
				</script><body></body>`,
				{ headers: { "Content-Type": "text/html" } },
			);
		},
	});
	const child = Bun.spawn(
		["bun", "apps/web/tests/release-candidate-browser.ts"],
		{
			env: { ...process.env, CANDIDATE_URL: `http://127.0.0.1:${server.port}` },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const timeout = setTimeout(() => child.kill(), 15_000);
	try {
		const [exitCode, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(streamOpened).toBe(true);
	} finally {
		clearTimeout(timeout);
		child.kill();
		server.stop(true);
	}
}, 25_000);
