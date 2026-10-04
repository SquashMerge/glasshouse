import { afterEach, expect, spyOn, test } from "bun:test";
import { setupE2eLocalAuth } from "../../../../infra/scripts/setup-e2e-local-auth.js";

const input = {
	apiBase: "http://api.test",
	origin: "http://web.test",
	username: "e2e-local-admin",
	password: "test-only-local-password",
	token: "test-only-bootstrap-token",
};
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchSpy?.mockRestore());

test("E2E fixture consumes setup once, checks closure, and rejects replay", async () => {
	const replies = [
		Response.json({ available: true }),
		Response.json({ ok: true }),
		Response.json({ available: false }),
		Response.json({ code: "UNAUTHORIZED" }, { status: 401 }),
	];
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		async (url, init) => {
			calls.push({ url: String(url), init });
			return replies.shift()!;
		},
	);
	await setupE2eLocalAuth(input);
	expect(calls.map(({ init }) => init?.method ?? "GET")).toEqual([
		"GET",
		"POST",
		"GET",
		"POST",
	]);
	expect(
		calls.every(({ url }) => url === `${input.apiBase}/v1/auth/setup`),
	).toBe(true);
	expect(calls[1]!.init!.headers).toEqual({
		"content-type": "application/json",
		origin: input.origin,
	});
	expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({
		username: input.username,
		password: input.password,
		token: input.token,
	});
});

test("E2E fixture refuses an already-closed setup instead of reopening storage", async () => {
	fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ available: false }),
	);
	await expect(setupE2eLocalAuth(input)).rejects.toThrow(
		"E2E setup must be open",
	);
	expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("E2E fixture rejects unexpected setup response fields and never includes them in errors", async () => {
	const replies = [
		Response.json({ available: true }),
		Response.json({ ok: true, token: input.token }),
	];
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		async () => replies.shift()!,
	);
	await expect(setupE2eLocalAuth(input)).rejects.toThrow(
		"E2E setup returned unexpected fields",
	);
});
