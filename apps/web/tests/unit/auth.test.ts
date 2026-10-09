import "./setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeOwnPassword, createFeedback } from "../../src/lib/api";
import {
	authedFetch,
	clearAuthSession,
	getAuthSession,
	logoutSession,
	onAuthInvalid,
	readAuthSession,
} from "../../src/lib/auth";

const session = {
	actor_id: "11111111-1111-4111-8111-111111111111",
	organization_id: "22222222-2222-4222-8222-222222222222",
	authentication: "local_session",
	username: "test.admin",
	expires_at: "2099-01-01T00:00:00.000Z",
	csrf_token: "test-only-csrf",
};
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status });
describe("opaque browser sessions", () => {
	const fetchMock = vi.fn();
	beforeEach(() => {
		clearAuthSession();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		clearAuthSession();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
	it("removes legacy credentials from both stores and retains only safe session context in memory", async () => {
		for (const storage of [window.localStorage, window.sessionStorage]) {
			storage.setItem("glasshouse.auth.username", "old-test-user");
			storage.setItem("glasshouse.auth.password", "old-test-password");
		}
		fetchMock.mockResolvedValue(json(session));
		await readAuthSession();
		for (const storage of [window.localStorage, window.sessionStorage]) {
			expect(storage.getItem("glasshouse.auth.username")).toBeNull();
			expect(storage.getItem("glasshouse.auth.password")).toBeNull();
			expect(JSON.stringify(storage)).not.toContain(session.csrf_token);
		}
		expect(getAuthSession()).toEqual(session);
	});
	it("uses cookies for reads and SSE; only unsafe methods get CSRF, never Basic", async () => {
		fetchMock.mockResolvedValueOnce(json(session));
		await readAuthSession();
		fetchMock.mockResolvedValue(json({}));
		for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
			await authedFetch("/v1/projects", {
				method,
				headers: { authorization: "Basic test-only-legacy-header" },
			});
			const init = fetchMock.mock.lastCall?.[1] as RequestInit;
			const headers = init.headers as Headers;
			expect(init.credentials).toBe("same-origin");
			expect(headers.get("authorization")).toBeNull();
			expect(headers.get("x-glasshouse-csrf")).toBe(
				["GET", "HEAD"].includes(method) ? null : session.csrf_token,
			);
		}
	});
	it("does not admit a local session without its separate CSRF value", async () => {
		for (const csrf_token of [null, "", 42]) {
			fetchMock.mockResolvedValueOnce(json({ ...session, csrf_token }));
			await expect(readAuthSession()).rejects.toThrow("Session");
			expect(getAuthSession()).toBeNull();
		}
	});
	it("never forwards CSRF or credentials to a foreign origin", async () => {
		await expect(
			authedFetch("https://foreign.example/v1/projects", { method: "POST" }),
		).rejects.toThrow("same-origin");
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("401 clears session and notifies the gate; unavailable servers retain it", async () => {
		fetchMock.mockResolvedValueOnce(json(session));
		await readAuthSession();
		const handler = vi.fn();
		const off = onAuthInvalid(handler);
		fetchMock.mockResolvedValueOnce(json({}, 500));
		await authedFetch("/v1/me");
		expect(getAuthSession()).toEqual(session);
		expect(handler).not.toHaveBeenCalled();
		fetchMock.mockResolvedValueOnce(json({}, 401));
		await authedFetch("/v1/me");
		expect(getAuthSession()).toBeNull();
		expect(handler).toHaveBeenCalledOnce();
		off();
	});
	it("logout revokes remotely before clearing state and reports failures for retry", async () => {
		fetchMock.mockResolvedValueOnce(json(session));
		await readAuthSession();
		fetchMock.mockResolvedValueOnce(json({}, 500));
		await expect(logoutSession()).rejects.toThrow("retry");
		expect(getAuthSession()).toEqual(session);
		fetchMock.mockResolvedValueOnce(json({ ok: true }));
		await logoutSession();
		expect(getAuthSession()).toBeNull();
		expect(fetchMock.mock.lastCall?.[0]).toBe("/v1/auth/logout");
	});
	it("late session reads cannot resurrect a cleared session", async () => {
		let resolve!: (response: Response) => void;
		fetchMock.mockReturnValue(
			new Promise<Response>((done) => {
				resolve = done;
			}),
		);
		const checking = readAuthSession();
		clearAuthSession();
		resolve(json(session));
		expect(await checking).toBeNull();
		expect(getAuthSession()).toBeNull();
	});
	it("a late 401 from an earlier session cannot invalidate a new sign-in", async () => {
		fetchMock.mockResolvedValueOnce(json(session));
		await readAuthSession();
		const handler = vi.fn();
		const off = onAuthInvalid(handler);
		try {
			let resolve!: (response: Response) => void;
			fetchMock.mockReturnValueOnce(
				new Promise<Response>((done) => {
					resolve = done;
				}),
			);
			const oldRequest = authedFetch("/v1/me");
			clearAuthSession();
			const replacement = {
				...session,
				csrf_token: "test-only-replacement-csrf",
			};
			fetchMock.mockResolvedValueOnce(json(replacement));
			await readAuthSession();
			resolve(json({}, 401));
			expect((await oldRequest).status).toBe(401);
			expect(getAuthSession()).toEqual(replacement);
			expect(handler).not.toHaveBeenCalled();
		} finally {
			off();
		}
	});
	it("preserves feedback comment JSON and its result under cookie auth", async () => {
		fetchMock.mockResolvedValueOnce(json(session));
		await readAuthSession();
		const body = {
			project_id: "11111111-1111-4111-8111-111111111111",
			trace_id: "a".repeat(32),
			value: 1 as const,
			metadata: {
				feedback: {
					schema_version: 1,
					sentiment: "positive",
					comment: "Helpful first-pass trace",
				},
			},
		};
		fetchMock.mockResolvedValueOnce(
			json(
				{
					project_id: body.project_id,
					trace_id: body.trace_id,
					value: 1,
					comment: body.metadata.feedback.comment,
					status: "reviewed",
				},
				201,
			),
		);

		const feedback = await createFeedback({
			...body,
			idempotency_key: "feedback-comment-test",
		});
		const [url, init] = fetchMock.mock.lastCall!;
		expect(url).toBe("/v1/feedback");
		expect(init?.method).toBe("POST");
		expect(init?.credentials).toBe("same-origin");
		expect(JSON.parse(init?.body as string)).toEqual(body);
		const headers = new Headers(init?.headers as HeadersInit);
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("idempotency-key")).toBe("feedback-comment-test");
		expect(headers.has("authorization")).toBe(false);
		expect(headers.get("x-glasshouse-csrf")).toBe(session.csrf_token);
		expect(feedback.comment).toBe("Helpful first-pass trace");
		expect(feedback.status).toBe("reviewed");
	});

	it("changes a local password through the same-origin cookie and CSRF contract", async () => {
		fetchMock.mockResolvedValueOnce(json(session));
		await readAuthSession();
		fetchMock.mockResolvedValueOnce(json({ ok: true }));
		await changeOwnPassword(
			"current-test-password",
			"replacement-test-password",
		);

		const [url, init] = fetchMock.mock.lastCall!;
		expect(url).toBe("/v1/auth/password");
		expect(init?.method).toBe("POST");
		expect(init?.credentials).toBe("same-origin");
		expect(JSON.parse(init?.body as string)).toEqual({
			current_password: "current-test-password",
			new_password: "replacement-test-password",
		});
		const headers = new Headers(init?.headers as HeadersInit);
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-glasshouse-csrf")).toBe(session.csrf_token);
		expect(headers.has("authorization")).toBe(false);
	});

	it("coalesces concurrent session reads", async () => {
		let resolve!: (response: Response) => void;
		fetchMock.mockReturnValueOnce(
			new Promise<Response>((done) => {
				resolve = done;
			}),
		);
		const first = readAuthSession();
		const second = readAuthSession();
		resolve(json(session));
		expect(await Promise.all([first, second])).toEqual([session, session]);
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
