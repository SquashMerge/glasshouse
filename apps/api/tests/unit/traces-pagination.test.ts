import { beforeEach, describe, expect, it, mock } from "bun:test";

const USER = "astraea";
const PASS = "secret";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

const defaultClient = mock(() => ({}));
const listTraces = mock(async () => ({ items: [], total: 0 }));
const listObservations = mock(async () => ({ items: [], total: 0 }));

mock.module("../../src/db/traces-query", () => ({
	defaultClient,
	getTrace: mock(async () => ({ trace: null, observations: [] })),
	listObservations,
	listTraces,
}));

process.env.UI_USERNAME = USER;
process.env.UI_PASSWORD = PASS;

const { createApiApp } = await import("../../src/index");
const apiApp = createApiApp();

function request(path: string): Request {
	return new Request(`http://x${path}`, { headers: { authorization: AUTH } });
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
				const res = await apiApp.fetch(request(`${path}?${query}`));
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

	it("uses the default trace pagination", async () => {
		const res = await apiApp.fetch(request("/v1/traces"));
		expect(res.status).toBe(200);
		expect(listTraces.mock.calls[0]?.slice(2)).toEqual([50, 0]);
	});

	it("accepts zero and the maximum trace page limit", async () => {
		const zero = await apiApp.fetch(request("/v1/traces?limit=0&offset=0"));
		expect(zero.status).toBe(200);
		expect(listTraces.mock.calls[0]?.slice(2)).toEqual([0, 0]);

		const maximum = await apiApp.fetch(
			request("/v1/traces?limit=200&offset=200"),
		);
		expect(maximum.status).toBe(200);
		expect(listTraces.mock.calls[1]?.slice(2)).toEqual([200, 200]);

		const maximumOffset = await apiApp.fetch(
			request("/v1/traces?offset=2147483647"),
		);
		expect(maximumOffset.status).toBe(200);
		expect(listTraces.mock.calls[2]?.slice(2)).toEqual([50, 2_147_483_647]);
	});

	it("passes the validated project selector into both list queries", async () => {
		const projectId = "11111111-1111-4111-8111-111111111111";

		const traces = await apiApp.fetch(
			request(`/v1/traces?project_id=${projectId}`),
		);
		expect(traces.status).toBe(200);
		expect(listTraces.mock.calls[0]?.[1]).toMatchObject({
			project_id: projectId,
		});

		const observations = await apiApp.fetch(
			request(`/v1/observations?project_id=${projectId}`),
		);
		expect(observations.status).toBe(200);
		expect(listObservations.mock.calls[0]?.[1]).toMatchObject({
			project_id: projectId,
		});
	});

	it("preserves the observation limit cap", async () => {
		const res = await apiApp.fetch(
			request("/v1/observations?limit=201&offset=3"),
		);
		expect(res.status).toBe(200);
		expect(listObservations.mock.calls[0]?.slice(2)).toEqual([200, 3]);
	});
});
