import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { securityHeaders } from "../../src/middleware/security-headers";

describe("securityHeaders", () => {
	it("sets all expected headers on a 200 response", async () => {
		const app = new Hono();
		app.use(securityHeaders());
		app.get("/x", (c) => c.json({ ok: true }));

		const res = await app.request("/x");
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(res.headers.get("X-DNS-Prefetch-Control")).toBe("off");
		expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
		expect(res.headers.get("Permissions-Policy")).toContain("microphone=()");
		expect(res.headers.get("Permissions-Policy")).toContain("geolocation=()");
	});

	it("applies headers on error responses too", async () => {
		const app = new Hono();
		app.use(securityHeaders());
		app.get("/x", () => new Response("nope", { status: 500 }));
		const res = await app.request("/x");
		expect(res.status).toBe(500);
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
	});

	it("enforces security headers even when a handler sets a weaker value", async () => {
		const app = new Hono();
		app.use(securityHeaders());
		app.get("/x", (c) => {
			c.header("X-Frame-Options", "SAMEORIGIN");
			return c.json({ ok: true });
		});
		const res = await app.request("/x");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
	});
});
