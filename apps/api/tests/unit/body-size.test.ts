import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import {
	bodySizeLimit,
	parseBodySizeLimit,
} from "../../src/middleware/body-size";

describe("bodySizeLimit", () => {
	const SMALL_LIMIT = 100; // bytes

	function buildApp() {
		const app = new Hono();
		app.use(bodySizeLimit(SMALL_LIMIT));
		app.post("/x", (c) => c.json({ received: true }));
		return app;
	}

	it("falls back to the default limit for malformed environment values", () => {
		expect(parseBodySizeLimit("not-a-number")).toBe(1_048_576);
	});

	it("accepts bodies under the limit", async () => {
		const app = buildApp();
		const res = await app.request("/x", {
			method: "POST",
			headers: { "content-type": "application/json", "content-length": "10" },
			body: '{"a":1}',
		});
		expect(res.status).toBe(200);
	});

	it("rejects bodies with Content-Length over the limit", async () => {
		const app = buildApp();
		const res = await app.request("/x", {
			method: "POST",
			headers: { "content-type": "application/json", "content-length": "1000" },
			body: "x",
		});
		expect(res.status).toBe(413);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("PAYLOAD_TOO_LARGE");
	});

	it("rejects streaming bodies that exceed the limit (no Content-Length)", async () => {
		const app = buildApp();
		const big = "x".repeat(500);
		const res = await app.request("/x", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: big,
		});
		expect(res.status).toBe(413);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("PAYLOAD_TOO_LARGE");
	});

	it("accepts streaming bodies that fit under the limit", async () => {
		const app = buildApp();
		const small = "x".repeat(50);
		const res = await app.request("/x", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: small,
		});
		expect(res.status).toBe(200);
	});
});
