import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "hono";
import { basicAuthMiddleware } from "../../src/middleware/auth";
import { MAX_TRACE_RESPONSE_BYTES } from "../../src/db/trace-payload-bounds";
import { encodeTraceCursor } from "../../src/db/trace-cursor";

const USER = "astraea";
const PASS = "secret";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

const defaultClient = mock(() => ({}));
const listTraces = mock(async () => ({ items: [], total: 0 }));
const listObservations = mock(async () => ({ items: [], total: 0 }));
const assertTenantProjectAccess = mock(async () => undefined);
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

mock.module("../../src/db/traces-query", () => ({
	defaultClient,
	getTrace: mock(async () => ({ trace: null, observations: [] })),
	listObservations,
	listTraces,
}));

process.env.UI_USERNAME = USER;
process.env.UI_PASSWORD = PASS;

const { createApiApp } = await import("../../src/index");
const { handleListObservations, handleListTraces } = await import(
	"../../src/routes/traces"
);
const apiApp = createApiApp({
	assertTenantProjectAccess,
	authenticate: () => basicAuthMiddleware(),
});

function request(path: string): Request {
	return new Request(`http://x${path}`, {
		headers: new Headers([["authorization", AUTH]]),
	});
}

function scopedRequest(path: string): Request {
	const url = new URL(`http://x${path}`);
	url.searchParams.set("project_id", PROJECT_ID);
	return request(`${url.pathname}${url.search}`);
}

function fakeContext(projectId: string): Context {
	return {
		req: {
			valid: () => ({ limit: 50, offset: 0, project_id: projectId }),
			query: () => undefined,
		},
		get: () => ({
			actor: "test",
			organizationId: "00000000-0000-4000-8000-000000000001",
		}),
		json: (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), { status }),
	} as unknown as Context;
}

beforeEach(() => {
	defaultClient.mockClear();
	listTraces.mockClear();
	listObservations.mockClear();
});

describe("trace pagination", () => {
	for (const path of ["/v1/traces", "/v1/observations"]) {
		it(`rejects a malformed project_id on ${path}`, async () => {
			const res = await apiApp.fetch(request(`${path}?project_id=not-a-uuid`));
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				code: "BAD_REQUEST",
				message: "Request validation failed",
			});
		});

		it(`rejects a missing project_id on ${path}`, async () => {
			const res = await apiApp.fetch(request(path));
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				code: "BAD_REQUEST",
				message: "Request validation failed",
			});
		});

		for (const query of [
			"limit=",
			"limit=%20",
			"limit=not-a-number",
			"limit=Infinity",
			"limit=1.5",
			"limit=-1",
			"offset=not-a-number",
			"offset=",
			"offset=%20",
			"offset=Infinity",
			"offset=1.5",
			"offset=-1",
			"offset=2147483648",
		]) {
			it(`rejects ${query} on ${path}`, async () => {
				const res = await apiApp.fetch(scopedRequest(`${path}?${query}`));
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					code: "BAD_REQUEST",
					message: "Request validation failed",
				});
				expect(listTraces).not.toHaveBeenCalled();
				expect(listObservations).not.toHaveBeenCalled();
			});
		}
	}

	it("returns an empty selected project as a normal trace collection", async () => {
		listTraces.mockResolvedValueOnce({ items: [], total: 0 });

		const res = await apiApp.fetch(scopedRequest("/v1/traces"));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ items: [], total: 0 });
		expect(listTraces.mock.calls[0]?.[1]).toMatchObject({
			organization_id: "00000000-0000-4000-8000-000000000001",
			project_id: PROJECT_ID,
		});
	});

	it("uses the default trace pagination", async () => {
		const res = await apiApp.fetch(scopedRequest("/v1/traces"));
		expect(res.status).toBe(200);
		expect(listTraces.mock.calls[0]?.slice(2)).toEqual([50, undefined, 0]);
	});

	it("preserves v1 zero and positive offset pagination for trace and observation lists", async () => {
		const zero = await apiApp.fetch(scopedRequest("/v1/traces?offset=0"));
		expect(zero.status).toBe(200);
		expect(listTraces.mock.calls[0]?.slice(2)).toEqual([50, undefined, 0]);

		const offset = await apiApp.fetch(
			scopedRequest("/v1/observations?limit=10&offset=25"),
		);
		expect(offset.status).toBe(200);
		expect(listObservations.mock.calls[0]?.slice(2)).toEqual([
			10,
			undefined,
			25,
		]);
	});

	it("rejects a cursor issued for another project before querying traces", async () => {
		const cursor = encodeTraceCursor("traces", OTHER_PROJECT_ID, {
			start_time: "2026-08-30 12:00:00.000",
			id: "0123456789abcdef0123456789abcdef",
		});

		const res = await apiApp.fetch(
			scopedRequest(`/v1/traces?cursor=${cursor}`),
		);

		expect(res.status).toBe(400);
		expect(listTraces).not.toHaveBeenCalled();
	});

	it("rejects a positive v1 offset combined with a keyset cursor before querying", async () => {
		const cursor = encodeTraceCursor("traces", PROJECT_ID, {
			start_time: "2026-08-30 12:00:00.000",
			id: "0123456789abcdef0123456789abcdef",
		});

		const res = await apiApp.fetch(
			scopedRequest(`/v1/traces?cursor=${cursor}&offset=1`),
		);

		expect(res.status).toBe(400);
		expect(listTraces).not.toHaveBeenCalled();
	});

	it("accepts supported list filters alongside the required project_id", async () => {
		const res = await apiApp.fetch(
			scopedRequest("/v1/traces?filter[env]=development"),
		);
		expect(res.status).toBe(200);
		expect(listTraces).toHaveBeenCalledTimes(1);
	});

	it("accepts zero and the maximum trace page limit", async () => {
		const zero = await apiApp.fetch(scopedRequest("/v1/traces?limit=0"));
		expect(zero.status).toBe(200);
		expect(listTraces.mock.calls[0]?.slice(2)).toEqual([0, undefined, 0]);

		const maximum = await apiApp.fetch(scopedRequest("/v1/traces?limit=200"));
		expect(maximum.status).toBe(200);
		expect(listTraces.mock.calls[1]?.slice(2)).toEqual([200, undefined, 0]);
	});

	it("passes the validated project selector into both list queries", async () => {
		const projectId = "11111111-1111-4111-8111-111111111111";

		const traces = await handleListTraces(fakeContext(projectId));
		expect(traces.status).toBe(200);
		expect(listTraces.mock.calls[0]?.[1]).toMatchObject({
			project_id: projectId,
		});

		const observations = await handleListObservations(fakeContext(projectId));
		expect(observations.status).toBe(200);
		expect(listObservations.mock.calls[0]?.[1]).toMatchObject({
			project_id: projectId,
		});
	});

	it("does not expose authenticated organization scope in REST list rows", async () => {
		const trace = {
			trace_id: "a".repeat(32),
			organization_id: "00000000-0000-4000-8000-000000000001",
			project_id: PROJECT_ID,
			name: "trace",
			start_time: "2024-01-01 00:00:00.000",
			end_time: null,
			duration_ms: null,
			status: "ok" as const,
			user_id: "",
			session_id: "",
			agent_id: "",
			agent_version: "",
			env: "test",
			tags: [],
			input_text: "",
			output_text: "",
			scores_summary: "",
		};
		const observation = {
			observation_id: "b".repeat(32),
			trace_id: trace.trace_id,
			organization_id: trace.organization_id,
			project_id: PROJECT_ID,
			parent_observation_id: null,
			type: "span" as const,
			name: "observation",
			start_time: trace.start_time,
			end_time: null,
			duration_ms: null,
			status: "ok" as const,
			model: null,
			input_text: "",
			output_text: "",
			metadata: "",
		};
		listTraces.mockResolvedValueOnce({ items: [trace], total: 1 });
		listObservations.mockResolvedValueOnce({ items: [observation], total: 1 });

		const traces = await apiApp.fetch(scopedRequest("/v1/traces"));
		const observations = await apiApp.fetch(scopedRequest("/v1/observations"));

		expect((await traces.json()).items[0]).not.toHaveProperty(
			"organization_id",
		);
		expect((await observations.json()).items[0]).not.toHaveProperty(
			"organization_id",
		);
	});

	it("serializes a bounded trace list response rather than materializing every projected row", async () => {
		listTraces.mockResolvedValueOnce({
			items: Array.from({ length: 200 }, (_, index) => ({
				trace_id: `${index}`.padStart(32, "0"),
				project_id: PROJECT_ID,
				name: "large",
				start_time: "2024-01-01 00:00:00.000",
				end_time: null,
				duration_ms: null,
				status: "ok",
				user_id: "",
				session_id: "",
				agent_id: "",
				agent_version: "",
				env: "test",
				tags: [],
				input_text: "界".repeat(8_000),
				output_text: "界".repeat(8_000),
				scores_summary: "",
			})),
			total: 200,
		});

		const response = await handleListTraces(fakeContext(PROJECT_ID));
		const raw = await response.text();
		expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(
			MAX_TRACE_RESPONSE_BYTES,
		);
		expect(JSON.parse(raw).response_truncated).toBe(true);
		expect(typeof JSON.parse(raw).next_cursor).toBe("string");
	});

	it("keeps an ASCII raw list response at the UTF-8 ceiling while retaining its continuation cursor", async () => {
		const trace = {
			trace_id: "a".repeat(32),
			project_id: PROJECT_ID,
			name: "",
			start_time: "2024-01-01 00:00:00.000",
			end_time: null,
			duration_ms: null,
			status: "ok" as const,
			user_id: "",
			session_id: "",
			agent_id: "",
			agent_version: "",
			env: "test",
			tags: [],
			input_text: "",
			output_text: "",
			scores_summary: "",
		};
		const presented = {
			...trace,
			start_time: "2024-01-01T00:00:00.000Z",
		};
		const continuation = {
			...trace,
			trace_id: "b".repeat(32),
			start_time: "2024-01-01 00:00:00.000",
		};
		const presentedContinuation = {
			...continuation,
			start_time: "2024-01-01T00:00:00.000Z",
		};
		continuation.name = "a".repeat(
			MAX_TRACE_RESPONSE_BYTES -
				new TextEncoder().encode(
					JSON.stringify({
						items: [presented, presentedContinuation],
						total: 2,
						response_truncated: true,
					}),
				).byteLength,
		);
		presentedContinuation.name = continuation.name;
		listTraces.mockResolvedValueOnce({
			items: [trace, continuation],
			total: 2,
			next_cursor: {
				start_time: continuation.start_time,
				id: continuation.trace_id,
			},
		});

		const response = await apiApp.fetch(scopedRequest("/v1/traces?limit=2"));
		const raw = await response.text();
		const page = JSON.parse(raw) as {
			items: Array<{ trace_id: string }>;
			response_truncated?: boolean;
			next_cursor?: string;
		};

		expect(response.status).toBe(200);
		expect(page.items).toHaveLength(1);
		expect(page.response_truncated).toBe(true);
		expect(page.next_cursor).toEqual(expect.any(String));
		expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(
			MAX_TRACE_RESPONSE_BYTES,
		);
	});

	it("rejects a list page whose only continuation-safe item cannot fit the UTF-8 ceiling", async () => {
		listTraces.mockResolvedValueOnce({
			items: [
				{
					trace_id: "c".repeat(32),
					project_id: PROJECT_ID,
					name: "a".repeat(MAX_TRACE_RESPONSE_BYTES),
					start_time: "2024-01-01 00:00:00.000",
					end_time: null,
					duration_ms: null,
					status: "ok" as const,
					user_id: "",
					session_id: "",
					agent_id: "",
					agent_version: "",
					env: "test",
					tags: [],
					input_text: "",
					output_text: "",
					scores_summary: "",
				},
			],
			total: 2,
			next_cursor: {
				start_time: "2024-01-01 00:00:00.000",
				id: "c".repeat(32),
			},
		});

		const response = await apiApp.fetch(scopedRequest("/v1/traces?limit=1"));

		expect(response.status).toBe(413);
	});

	it("preserves the observation limit cap", async () => {
		const res = await apiApp.fetch(scopedRequest("/v1/observations?limit=201"));
		expect(res.status).toBe(200);
		expect(listObservations.mock.calls[0]?.slice(2)).toEqual([
			200,
			undefined,
			0,
		]);
	});
});
