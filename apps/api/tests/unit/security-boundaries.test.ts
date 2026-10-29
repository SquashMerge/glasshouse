import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { explainCase } from "../../src/lib/evaluator";
import { EvaluationEvaluator } from "../../src/schemas/evaluations";
import {
	validLocalPassword,
	verifyLocalPassword,
} from "../../src/lib/local-passwords";
import { authenticationMiddleware } from "../../src/middleware/auth";
import { invokeConfiguredLlm } from "../../src/lib/llm";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
	setupRoute,
	acceptInvitationRoute,
	changePasswordRoute,
	loginRoute,
} from "../../src/routes/auth";

const environment = { ...process.env };
const originalFetch = globalThis.fetch;
afterEach(() => {
	process.env = { ...environment };
	globalThis.fetch = originalFetch;
});

test("evaluation paths reject prototype segments and never compare inherited values", () => {
	for (const segment of ["__proto__", "constructor", "prototype"]) {
		for (const path of [`$.${segment}`, `$.nested.${segment}.value`]) {
			expect(
				EvaluationEvaluator.safeParse({
					kind: "exact_match",
					version: "v1",
					output_path: path,
				}).success,
			).toBe(false);
			expect(
				explainCase(
					{
						kind: "exact_match",
						version: "v1",
						expected_output_path: path,
						output_path: path,
					},
					{},
					{},
				).score,
			).toBe(0);
		}
	}
	const contract = {
		kind: "exact_match",
		version: "v1",
		expected_output_path: "$.nested.value",
		output_path: "$.nested.value",
	} as const;
	expect(
		explainCase(
			contract,
			Object.create({ nested: { value: "same" } }),
			Object.create({ nested: { value: "same" } }),
		).score,
	).toBe(0);
	expect(
		explainCase(
			contract,
			{ nested: Object.create({ value: "same" }) },
			{ nested: Object.create({ value: "same" }) },
		).score,
	).toBe(0);
	expect(explainCase(contract, {}, {}).score).toBe(0);
	for (const value of [null, false, 0, "", { x: [1, 2] }])
		expect(
			explainCase(contract, { nested: { value } }, { nested: { value } }).score,
		).toBe(1);
});

test("new local passwords require 12 Unicode code points and at most 1024 UTF-8 bytes", () => {
	for (const value of [
		"x",
		"x".repeat(11),
		"😀".repeat(11),
		"é".repeat(513),
		"x".repeat(1025),
	])
		expect(validLocalPassword(value)).toBe(false);
	for (const value of [
		"x".repeat(12),
		"😀".repeat(12),
		"é".repeat(512),
		"x".repeat(1024),
	])
		expect(validLocalPassword(value)).toBe(true);
});

test("legacy short passwords remain verifiable", async () => {
	const password_hash = await Bun.password.hash("x", {
		algorithm: "argon2id",
		memoryCost: 8192,
		timeCost: 1,
	});
	expect(
		(
			await verifyLocalPassword("x", {
				password_hash,
				password_algorithm: "argon2id",
				password_version: 1,
			})
		).verified,
	).toBe(true);
});

test("all password-setting HTTP contracts enforce the new policy while login accepts legacy passwords", async () => {
	for (const route of [
		setupRoute,
		acceptInvitationRoute,
		changePasswordRoute,
		loginRoute,
	]) {
		const app = new OpenAPIHono();
		app.openapi(
			route as never,
			((c: { json: (body: unknown) => Response }) =>
				c.json({ ok: true })) as never,
		);
		for (const value of [
			"x",
			"😀".repeat(11),
			"😀".repeat(12),
			"x".repeat(1024),
			"é".repeat(513),
		]) {
			const payload =
				route === setupRoute
					? { username: "Admin", token: "a".repeat(43), password: value }
					: route === acceptInvitationRoute
						? { token: "a".repeat(43), password: value }
						: route === changePasswordRoute
							? { current_password: "x", new_password: value }
							: { username: "Admin", password: value };
			const result = await app.request(route.path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const accepted =
				Buffer.byteLength(value) <= 1024 &&
				(route === loginRoute || Array.from(value).length >= 12);
			expect(result.status).toBe(accepted ? 200 : 400);
		}
	}
});

test("production auth validation maps invalid password policy to 401", async () => {
	const { createApiApp } = await import("../../src/index");
	const app = createApiApp({
		authenticate: () => async (_c, next) => next(),
	});
	const response = await app.request("http://localhost/v1/auth/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			username: "Admin",
			token: "a".repeat(43),
			password: "short",
		}),
	});

	expect(response.status).toBe(401);
	expect(await response.json()).toMatchObject({
		code: "UNAUTHORIZED",
		message: "Authentication required",
	});
});

test("Basic browser mutations reject cross-origin and fetch metadata but allow same-origin and non-browser clients", async () => {
	delete process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
	process.env.UI_USERNAME = "test";
	process.env.UI_PASSWORD = "test";
	process.env.GLASSHOUSE_PUBLIC_ORIGIN = "https://glasshouse.example";
	let mutations = 0;
	const pool = {
		query: async () => ({ rows: [], rowCount: 1 }),
		connect: async () => ({
			query: async () => ({ rows: [], rowCount: 1 }),
			release() {},
		}),
	};
	const app = new Hono();
	app.use(
		"*",
		authenticationMiddleware(
			() => pool as never,
			() => pool as never,
		),
	);
	app.post("/v1/runs/cancel", (c) => {
		mutations++;
		return c.json({ ok: true });
	});
	app.get("/v1/read", (c) => c.json({ ok: true }));
	const authorization = `Basic ${btoa("test:test")}`;
	for (const extra of [
		{ origin: "https://evil.example" },
		{ origin: "null" },
		{ "sec-fetch-site": "cross-site" },
		{ "sec-fetch-site": "same-site" },
		{ origin: "https://glasshouse.example", "sec-fetch-site": "cross-site" },
	]) {
		const response = await app.request(
			"https://glasshouse.example/v1/runs/cancel",
			{ method: "POST", headers: { authorization, ...extra } },
		);
		expect(response.status).toBe(403);
	}
	expect(mutations).toBe(0);
	for (const extra of [
		{},
		{ origin: "https://glasshouse.example", "sec-fetch-site": "same-origin" },
		{ "sec-fetch-site": "none" },
	]) {
		expect(
			(
				await app.request("https://glasshouse.example/v1/runs/cancel", {
					method: "POST",
					headers: { authorization, ...extra },
				})
			).status,
		).toBe(200);
	}
	expect(
		(
			await app.request("https://glasshouse.example/v1/read", {
				headers: { authorization, origin: "https://evil.example" },
			})
		).status,
	).toBe(200);
});

test("provider response cap applies to ignored JSON fields before parsing and cancels the stream", async () => {
	process.env.OPENAI_API_KEY = "test-only";
	let cancelled = false;
	let chunks = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			chunks++;
			controller.enqueue(
				new TextEncoder().encode(
					chunks === 1
						? '{"choices":[{"message":{"content":"ok"}}],"ignored":"'
						: "x".repeat(16 * 1024),
				),
			);
			if (chunks === 40) {
				controller.enqueue(new TextEncoder().encode('"}'));
				controller.close();
			}
		},
		cancel() {
			cancelled = true;
		},
	});
	globalThis.fetch = (async () => new Response(body)) as typeof fetch;
	await expect(invokeConfiguredLlm({}, { model: "test" })).rejects.toThrow();
	expect(cancelled).toBe(true);
	expect(chunks).toBeLessThan(40);
});

test("provider metadata is bounded and normal responses retain their contract", async () => {
	process.env.OPENAI_API_KEY = "test-only";
	const payload = {
		choices: [{ message: { content: "ok" } }],
		model: "test",
		usage: { prompt_tokens: 1, completion_tokens: 2 },
		cost_usd: 0.01,
	};
	globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
	await expect(
		invokeConfiguredLlm({}, { model: "test" }),
	).resolves.toMatchObject({
		output: { value: "ok" },
		model: "test",
		prompt_tokens: 1,
		cost_usd: 0.01,
	});
	globalThis.fetch = (async () =>
		Response.json({ ...payload, model: "m".repeat(201) })) as typeof fetch;
	await expect(invokeConfiguredLlm({}, { model: "test" })).rejects.toThrow();
});

test("aborting a provider body read cancels a pending reader", async () => {
	process.env.OPENAI_API_KEY = "test-only";
	let cancelled = false;
	let streamController: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
		cancel() {
			cancelled = true;
		},
	});
	globalThis.fetch = (async () => new Response(body)) as typeof fetch;
	const controller = new AbortController();
	const result = invokeConfiguredLlm({}, { model: "test" }, controller.signal);
	setTimeout(() => controller.abort(), 10);
	const outcome = await Promise.race([
		result.then(
			() => "resolved",
			() => "rejected",
		),
		Bun.sleep(100).then(() => "pending"),
	]);
	if (!cancelled) streamController!.close();
	await result.catch(() => {});
	expect(outcome).toBe("rejected");
	expect(cancelled).toBe(true);
}, 1000);
