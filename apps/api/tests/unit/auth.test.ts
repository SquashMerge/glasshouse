import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import {
	basicAuthMiddleware,
	TRUSTED_ACTOR_CONTEXT_KEY,
	TRUSTED_TENANT_CONTEXT_KEY,
} from "../../src/middleware/auth";

describe("basicAuthMiddleware", () => {
	beforeAll(() => {
		process.env.UI_USERNAME = "glasshouse";
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
			/^Basic realm="glasshouse"/,
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
		const wrong = Buffer.from("glasshouse:wrongpass").toString("base64");
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
		const correct = Buffer.from("glasshouse:secret123").toString("base64");
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
		const correct = Buffer.from("glasshouse:secret123").toString("base64");
		const res = await app.request("/v1/protected", {
			headers: { authorization: `Basic ${correct}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; actor: string };
		expect(body.actor).toBe("glasshouse");
	});

	it("stores the default organization as trusted server context for legacy credentials", async () => {
		const app = new Hono();
		app.use("/v1/*", basicAuthMiddleware());
		app.get("/v1/protected", (c) =>
			c.json({ tenant: c.get(TRUSTED_TENANT_CONTEXT_KEY) }),
		);
		const correct = Buffer.from("glasshouse:secret123").toString("base64");
		const res = await app.request("/v1/protected", {
			headers: { authorization: `Basic ${correct}` },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			tenant: {
				actor: "glasshouse",
				actorId: expect.stringMatching(/^[0-9a-f-]{36}$/),
				organizationId: "00000000-0000-4000-8000-000000000001",
			},
		});
	});

	it("assigns each configured credential only its configured organization", async () => {
		const original = process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
		process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = JSON.stringify([
			{
				username: "org-a-user",
				password: "org-a-secret",
				organization_id: "00000000-0000-4000-8000-000000000010",
			},
			{
				username: "org-b-user",
				password: "org-b-secret",
				organization_id: "00000000-0000-4000-8000-000000000020",
			},
		]);
		try {
			const app = new Hono();
			app.use("/v1/*", basicAuthMiddleware());
			app.get("/v1/protected", (c) =>
				c.json({ tenant: c.get(TRUSTED_TENANT_CONTEXT_KEY) }),
			);
			const auth = Buffer.from("org-b-user:org-b-secret").toString("base64");
			const res = await app.request("/v1/protected", {
				headers: { authorization: `Basic ${auth}` },
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				tenant: {
					actor: "org-b-user",
					actorId: expect.stringMatching(/^[0-9a-f-]{36}$/),
					organizationId: "00000000-0000-4000-8000-000000000020",
				},
			});
		} finally {
			if (original === undefined)
				delete process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
			else process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = original;
		}
	});

	it("rejects Basic credentials that collide after canonical normalization", () => {
		const original = process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
		process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = JSON.stringify([
			{
				username: "Alice",
				password: "one",
				organization_id: "00000000-0000-4000-8000-000000000010",
			},
			{
				username: " alice ",
				password: "two",
				organization_id: "00000000-0000-4000-8000-000000000020",
			},
		]);
		try {
			expect(() => basicAuthMiddleware()).toThrow(/canonical usernames/);
		} finally {
			if (original === undefined)
				delete process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
			else process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = original;
		}
	});

	it("throws at construction if UI_PASSWORD is unset", () => {
		const orig = process.env.UI_PASSWORD;
		delete process.env.UI_PASSWORD;
		expect(() => basicAuthMiddleware()).toThrow(/UI_PASSWORD/);
		process.env.UI_PASSWORD = orig;
	});
});
