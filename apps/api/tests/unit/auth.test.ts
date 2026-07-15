import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { basicAuthMiddleware, TRUSTED_ACTOR_CONTEXT_KEY } from "../../src/middleware/auth";

describe("basicAuthMiddleware", () => {
	beforeAll(() => {
		process.env.UI_USERNAME = "astraea";
		process.env.UI_PASSWORD = "secret123";
	});

	function buildApp() {
		const app = new Hono();
		app.use("/v1/*", basicAuthMiddleware());
		app.get("/v1/protected", (c) =>
			c.json({ ok: true, actor: c.get(TRUSTED_ACTOR_CONTEXT_KEY) }),
		);
		return app;
	}

	it("rejects requests without Authorization header", async () => {
		const app = buildApp();
		const res = await app.request("/v1/protected");
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toMatch(
			/^Basic realm="astraea"/,
		);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("UNAUTHORIZED");
	});

	it("rejects requests with non-Basic scheme", async () => {
		const app = buildApp();
		const res = await app.request("/v1/protected", {
			headers: { authorization: "Bearer xyz" },
		});
		expect(res.status).toBe(401);
	});

	it("rejects requests with malformed Basic header", async () => {
		const app = buildApp();
		const res = await app.request("/v1/protected", {
			headers: { authorization: "Basic not-base64!!!" },
		});
		expect(res.status).toBe(401);
	});

	it("rejects oversized Authorization headers before decoding", async () => {
		const app = buildApp();
		const res = await app.request("/v1/protected", {
			headers: { authorization: `Basic ${"A".repeat(8192)}` },
		});
		expect(res.status).toBe(401);
	});

	it("rejects requests with no colon in decoded payload", async () => {
		const app = buildApp();
		const noColon = Buffer.from("nocolon").toString("base64");
		const res = await app.request("/v1/protected", {
			headers: { authorization: `Basic ${noColon}` },
		});
		expect(res.status).toBe(401);
	});

	it("rejects requests with wrong username", async () => {
		const app = buildApp();
		const wrong = Buffer.from("wronguser:secret123").toString("base64");
		const res = await app.request("/v1/protected", {
			headers: { authorization: `Basic ${wrong}` },
		});
		expect(res.status).toBe(401);
	});

	it("rejects requests with wrong password", async () => {
		const app = buildApp();
		const wrong = Buffer.from("astraea:wrongpass").toString("base64");
		const res = await app.request("/v1/protected", {
			headers: { authorization: `Basic ${wrong}` },
		});
		expect(res.status).toBe(401);
	});

	it("rejects requests with both wrong (length-mismatch path is padded so it should still 401)", async () => {
		const app = buildApp();
		const wrong = Buffer.from("w:wrongpasslongerthanreal").toString("base64");
		const res = await app.request("/v1/protected", {
			headers: { authorization: `Basic ${wrong}` },
		});
		expect(res.status).toBe(401);
	});

	it("accepts requests with correct credentials", async () => {
		const app = buildApp();
		const correct = Buffer.from("astraea:secret123").toString("base64");
		const res = await app.request("/v1/protected", {
			headers: { authorization: `Basic ${correct}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	it("throws at construction if UI_USERNAME is unset", () => {
		const orig = process.env.UI_USERNAME;
		delete process.env.UI_USERNAME;
		expect(() => basicAuthMiddleware()).toThrow(/UI_USERNAME/);
		process.env.UI_USERNAME = orig;
	});

	it("stores the verified username as the trusted actor", async () => {
		const app = buildApp();
		const correct = Buffer.from("astraea:secret123").toString("base64");
		const res = await app.request("/v1/protected", {
			headers: { authorization: `Basic ${correct}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { actor: string };
		expect(body.actor).toBe("astraea");
	});

	it("throws at construction if UI_PASSWORD is unset", () => {
		const orig = process.env.UI_PASSWORD;
		delete process.env.UI_PASSWORD;
		expect(() => basicAuthMiddleware()).toThrow(/UI_PASSWORD/);
		process.env.UI_PASSWORD = orig;
	});
});
