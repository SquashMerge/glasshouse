import "./setup";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
	setCredentials,
	clearCredentials,
	getCredentials,
	authHeader,
	authedFetch,
	onAuthInvalid,
} from "../../src/lib/auth";

describe("credentials helpers", () => {
	beforeEach(() => {
		window.localStorage.clear();
		window.sessionStorage.clear();
		clearCredentials();
	});
	afterEach(() => {
		window.localStorage.clear();
		window.sessionStorage.clear();
		clearCredentials();
	});

	it("keeps credentials in memory and removes legacy persisted credentials", () => {
		window.localStorage.setItem("astraea.auth.username", "previous-user");
		window.localStorage.setItem("astraea.auth.password", "previous-password");
		setCredentials("alice", "hunter2");
		expect(getCredentials()).toEqual({
			username: "alice",
			password: "hunter2",
		});
		expect(window.localStorage.getItem("astraea.auth.username")).toBeNull();
		expect(window.localStorage.getItem("astraea.auth.password")).toBeNull();
		expect(window.sessionStorage.getItem("astraea.auth.username")).toBeNull();
		expect(window.sessionStorage.getItem("astraea.auth.password")).toBeNull();
	});

	it("clearCredentials removes in-memory and legacy persisted credentials", () => {
		setCredentials("alice", "hunter2");
		window.localStorage.setItem("astraea.auth.username", "alice");
		window.localStorage.setItem("astraea.auth.password", "hunter2");
		clearCredentials();
		expect(getCredentials()).toBeNull();
		expect(window.localStorage.getItem("astraea.auth.username")).toBeNull();
		expect(window.localStorage.getItem("astraea.auth.password")).toBeNull();
	});

	it("does not restore credentials from legacy storage", () => {
		window.localStorage.setItem("astraea.auth.username", "alice");
		window.localStorage.setItem("astraea.auth.password", "hunter2");
		expect(getCredentials()).toBeNull();
		expect(window.localStorage.getItem("astraea.auth.username")).toBeNull();
		expect(window.localStorage.getItem("astraea.auth.password")).toBeNull();
	});

	it("keeps credentials in memory when storage access throws", () => {
		const removeItemSpy = vi
			.spyOn(Storage.prototype, "removeItem")
			.mockImplementation(() => {
				throw new Error("storage is unavailable");
			});

		expect(() => setCredentials("alice", "hunter2")).not.toThrow();
		expect(getCredentials()).toEqual({
			username: "alice",
			password: "hunter2",
		});
		removeItemSpy.mockRestore();
	});
});

describe("authHeader", () => {
	it("returns empty object when creds are null", () => {
		expect(authHeader(null)).toEqual({});
	});

	it("encodes credentials as Basic <base64(user:pass)>", () => {
		const header = authHeader({ username: "alice", password: "hunter2" });
		expect(header).toEqual({
			authorization: "Basic " + Buffer.from("alice:hunter2").toString("base64"),
		});
	});
});

describe("authedFetch 401 handling", () => {
	beforeEach(() => {
		window.localStorage.clear();
		vi.restoreAllMocks();
	});
	afterEach(() => {
		window.localStorage.clear();
	});

	it("clears credentials and dispatches auth-invalid on 401", async () => {
		setCredentials("alice", "hunter2");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response("nope", {
				status: 401,
				headers: { "content-type": "application/json" },
			}),
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const handler = vi.fn();
		const off = onAuthInvalid(handler);

		try {
			const res = await authedFetch("http://x/v1/traces");
			expect(res.status).toBe(401);
			expect(getCredentials()).toBeNull();
			expect(handler).toHaveBeenCalledTimes(1);
		} finally {
			globalThis.fetch = originalFetch;
			off();
		}
	});

	it("does not clear credentials on 200", async () => {
		setCredentials("alice", "hunter2");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const handler = vi.fn();
		const off = onAuthInvalid(handler);

		try {
			const res = await authedFetch("http://x/v1/traces");
			expect(res.status).toBe(200);
			expect(getCredentials()).toEqual({
				username: "alice",
				password: "hunter2",
			});
			expect(handler).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
			off();
		}
	});

	it("does not clear credentials on 500 (only 401 triggers re-auth)", async () => {
		setCredentials("alice", "hunter2");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response("oops", {
				status: 500,
				headers: { "content-type": "application/json" },
			}),
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const handler = vi.fn();
		const off = onAuthInvalid(handler);

		try {
			const res = await authedFetch("http://x/v1/traces");
			expect(res.status).toBe(500);
			expect(getCredentials()).toEqual({
				username: "alice",
				password: "hunter2",
			});
			expect(handler).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
			off();
		}
	});

	it("attaches Basic Auth header from in-memory credentials", async () => {
		setCredentials("alice", "hunter2");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		try {
			await authedFetch("http://x/v1/traces");
			const calledWith = fetchMock.mock.calls[0] as
				| Parameters<typeof fetch>
				| undefined;
			const init = (calledWith?.[1] ?? {}) as RequestInit;
			const headers = init.headers as Headers;
			expect(headers.get("authorization")).toBe(
				"Basic " + Buffer.from("alice:hunter2").toString("base64"),
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
