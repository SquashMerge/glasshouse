import "./setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	authedFetch,
	clearCredentials,
	getCredentials,
	logoutSession,
	onAuthInvalid,
	restoreLocalSession,
} from "../../src/lib/auth";

function sessionResponse() {
	return Response.json({
		authentication: "local_session",
		csrf_token: "test-csrf",
	});
}

describe("browser local session adapter", () => {
	beforeEach(() => {
		clearCredentials();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => sessionResponse()),
		);
	});
	afterEach(() => {
		clearCredentials();
		vi.unstubAllGlobals();
	});

	it("restores cookie auth without retaining passwords or CSRF in web storage", async () => {
		window.sessionStorage.setItem("astraea.auth.password", "legacy-password");
		expect(await restoreLocalSession("local-admin")).toBe(true);
		expect(getCredentials()).toEqual({ username: "local-admin", password: "" });
		expect(window.sessionStorage.getItem("astraea.auth.password")).toBeNull();
		expect(window.localStorage.getItem("astraea.auth.password")).toBeNull();
		expect(JSON.stringify(window.sessionStorage)).not.toContain("test-csrf");
	});

	it("uses cookies and CSRF for unsafe methods, including lowercase verbs and SSE POST", async () => {
		await restoreLocalSession();
		for (const method of ["POST", "put", "PATCH", "DELETE"]) {
			await authedFetch("/v1/example", {
				method,
				headers: { authorization: "Basic stale", "x-extra": "kept" },
			});
			const init = vi.mocked(fetch).mock.calls.at(-1)![1]!;
			const headers = init.headers as Headers;
			expect(init.credentials).toBe("same-origin");
			expect(headers.get("authorization")).toBeNull();
			expect(headers.get("x-astraea-csrf")).toBe("test-csrf");
			expect(headers.get("x-extra")).toBe("kept");
		}
		await authedFetch("/v1/traces/events");
		expect(
			(vi.mocked(fetch).mock.calls.at(-1)![1]!.headers as Headers).has(
				"x-astraea-csrf",
			),
		).toBe(false);
	});

	it("revokes on logout before discarding the session", async () => {
		await restoreLocalSession();
		vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true }));
		await logoutSession();
		expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toBe("/v1/auth/logout");
		expect(getCredentials()).toBeNull();
	});

	it("fails closed on 401 and rejects Basic-only session restoration", async () => {
		await restoreLocalSession();
		const invalid = vi.fn();
		const off = onAuthInvalid(invalid);
		try {
			vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
			await authedFetch("/v1/projects");
			expect(getCredentials()).toBeNull();
			expect(invalid).toHaveBeenCalledOnce();
			vi.mocked(fetch).mockResolvedValueOnce(
				Response.json({ authentication: "basic", csrf_token: null }),
			);
			expect(await restoreLocalSession()).toBe(false);
		} finally {
			off();
		}
	});

	it("does not resurrect a session from an in-flight check after logout", async () => {
		let settle!: (response: Response) => void;
		vi.mocked(fetch).mockReturnValueOnce(
			new Promise((resolve) => {
				settle = resolve;
			}),
		);
		const restoring = restoreLocalSession();
		clearCredentials();
		settle(sessionResponse());
		expect(await restoring).toBe(false);
		expect(getCredentials()).toBeNull();
	});

	it("concurrent restoration checks accept the established session without overwriting it", async () => {
		const results = await Promise.all([
			restoreLocalSession("local-admin"),
			restoreLocalSession(),
		]);
		expect(results).toEqual([true, true]);
		expect(getCredentials()!.username).toBe("local-admin");
	});
});
