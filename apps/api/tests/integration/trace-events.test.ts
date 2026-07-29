// apps/api/tests/integration/trace-events.test.ts
//
// End-to-end integration coverage for the three SSE endpoints, going through
// the full Hono stack (auth middleware, route handler, real in-process event
// bus, mocked ClickHouse). The fake event bus is the REAL bus — same process
// — so AC8's "two SSE clients both see events" can be proved by opening two
// parallel connections to /v1/traces/{id}/events and asserting both readers
// receive the published observation.
//
// Uses the same env tunables as the unit test (SSE_HEARTBEAT_MS, TRACE_COMPLETE_GRACE_MS)
// to keep wall-clock time bounded.

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { TraceRow, ObservationRow } from "../../src/db/traces-query";
import {
	_resetForTests,
	publishSync,
	subscribe,
} from "../../src/lib/event-bus";
import { basicAuthMiddleware } from "../../src/middleware/auth";
import {
	createTraceEventHandlers,
	streamObservationEvents,
	streamTraceDetailEvents,
	streamTraceEvents,
} from "../../src/routes/trace-events";

const VALID_TRACE_ID = "0123456789abcdef0123456789abcdef";
const DEFAULT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

const fakeTrace: TraceRow = {
	trace_id: VALID_TRACE_ID,
	organization_id: DEFAULT_ORGANIZATION_ID,
	project_id: "proj-it",
	name: "integration-trace",
	start_time: "2024-01-01 00:00:00.000",
	end_time: null,
	duration_ms: null,
	status: "ok",
	user_id: "",
	session_id: "",
	agent_id: "",
	agent_version: "",
	env: "production",
	tags: [],
	input_text: "",
	output_text: "",
	scores_summary: "",
};

const fakeObservation: ObservationRow = {
	observation_id: "obs-it-1",
	trace_id: VALID_TRACE_ID,
	organization_id: DEFAULT_ORGANIZATION_ID,
	project_id: "proj-it",
	parent_observation_id: null,
	type: "generation",
	name: "it-obs",
	start_time: "2024-01-01 00:00:00.000",
	end_time: null,
	duration_ms: null,
	status: "ok",
	model: "gpt-4o",
	input_text: "",
	output_text: "",
	metadata: JSON.stringify([
		{ key: "model", value: { stringValue: "gpt-4o" } },
		{ key: "tokens", value: { intValue: 7 } },
	]),
};

const getTraceMock = mock(async () => ({
	trace: fakeTrace,
	observations: [fakeObservation],
}));
const defaultClientMock = mock(() => ({}));

// Env + auth: route modules read SSE_HEARTBEAT_MS / TRACE_COMPLETE_GRACE_MS
// once at import time — set BEFORE importing the app.
process.env.SSE_HEARTBEAT_MS = "50";
process.env.TRACE_COMPLETE_GRACE_MS = "200";

const USER = "astraea";
const PASS = "secret";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
process.env.UI_USERNAME = USER;
process.env.UI_PASSWORD = PASS;

const traceEventHandlers = createTraceEventHandlers({
	defaultClient: defaultClientMock,
	getTrace: getTraceMock,
	graceMs: 200,
	heartbeatMs: 50,
	subscribe,
});
const apiApp = new OpenAPIHono({
	defaultHook: (result, c) =>
		result.success
			? undefined
			: c.json(
					{ code: "BAD_REQUEST", message: "Request validation failed" },
					400,
				),
});
apiApp.use("/v1/*", basicAuthMiddleware());
apiApp.openapi(streamTraceEvents, traceEventHandlers.handleStreamTraceEvents);
apiApp.openapi(
	streamObservationEvents,
	traceEventHandlers.handleStreamObservationEvents,
);
apiApp.openapi(
	streamTraceDetailEvents,
	traceEventHandlers.handleStreamTraceDetailEvents,
);

// ---------------------------------------------------------------------------
// SSE stream helpers — reads frames incrementally from a ReadableStream.
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

type SSEFrame = { event?: string; data: string };

function parseFrame(raw: string): SSEFrame {
	let event: string | undefined;
	const dataLines: string[] = [];
	for (const line of raw.split("\n")) {
		if (line.startsWith(":")) continue;
		if (line.startsWith("event: ")) event = line.slice("event: ".length);
		else if (line.startsWith("data: "))
			dataLines.push(line.slice("data: ".length));
	}
	return { event, data: dataLines.join("\n") };
}

/** Read frames until `predicate` matches or `timeoutMs` elapses. */
async function readFramesUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	predicate: (frames: SSEFrame[]) => boolean,
	opts: { timeoutMs?: number; maxFrames?: number } = {},
): Promise<SSEFrame[]> {
	const timeoutMs = opts.timeoutMs ?? 1_000;
	const maxFrames = opts.maxFrames ?? 200;
	const frames: SSEFrame[] = [];
	let buf = "";
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline && frames.length < maxFrames) {
		const remaining = deadline - Date.now();
		const readPromise = reader.read();
		const timer = new Promise<{ value: undefined; done: true }>((resolve) =>
			setTimeout(
				() => resolve({ value: undefined, done: true }),
				Math.max(5, remaining),
			),
		);
		const result = await Promise.race([readPromise, timer]);
		if (result.done) break;
		buf += decoder.decode(result.value, { stream: true });
		let idx: number;
		while ((idx = buf.indexOf("\n\n")) >= 0) {
			const raw = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			frames.push(parseFrame(raw));
		}
		if (predicate(frames)) return frames;
	}
	return frames;
}

/** Drain :ok + the rest of the preamble so subsequent reads see only events. */
async function readOkAndSnapshot(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<SSEFrame[]> {
	return readFramesUntil(reader, (f) => f.some((x) => x.event === "snapshot"), {
		timeoutMs: 500,
	});
}

beforeEach(() => {
	getTraceMock.mockClear();
	defaultClientMock.mockClear();
	_resetForTests();
	getTraceMock.mockResolvedValue({
		trace: fakeTrace,
		observations: [fakeObservation],
	});
});

afterEach(() => {
	_resetForTests();
});

// ---------------------------------------------------------------------------
// 1. Auth gate
// ---------------------------------------------------------------------------

describe("SSE endpoints: auth gate (AC8 proxy via 401)", () => {
	it("GET /v1/traces/events without Authorization returns 401 with WWW-Authenticate", async () => {
		const res = await apiApp.fetch(new Request("http://x/v1/traces/events"));
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toMatch(
			/^Basic realm="astraea"/,
		);
	});

	it("GET /v1/observations/events without Authorization returns 401", async () => {
		const res = await apiApp.fetch(
			new Request("http://x/v1/observations/events"),
		);
		expect(res.status).toBe(401);
	});

	it("GET /v1/traces/{id}/events without Authorization returns 401", async () => {
		const res = await apiApp.fetch(
			new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`),
		);
		expect(res.status).toBe(401);
	});
});

// ---------------------------------------------------------------------------
// 2. /v1/traces/events — order-preserved dispatch
// ---------------------------------------------------------------------------

describe("GET /v1/traces/events (list SSE)", () => {
	it("three published traces arrive in order on a single connection", async () => {
		const res = await apiApp.fetch(
			new Request("http://x/v1/traces/events", {
				method: "GET",
				headers: { authorization: AUTH },
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

		const reader = res.body!.getReader();
		// Drain :ok so we only see the published frames.
		await reader.read();

		const trace1: TraceRow = {
			...fakeTrace,
			trace_id: "t1".padEnd(32, "0"),
			name: "a",
		};
		const trace2: TraceRow = {
			...fakeTrace,
			trace_id: "t2".padEnd(32, "0"),
			name: "b",
		};
		const trace3: TraceRow = {
			...fakeTrace,
			trace_id: "t3".padEnd(32, "0"),
			name: "c",
		};

		publishSync("trace.created", { trace: trace1 });
		publishSync("trace.created", { trace: trace2 });
		publishSync("trace.created", { trace: trace3 });

		const frames = await readFramesUntil(
			reader,
			(f) => f.filter((x) => x.event === "trace").length >= 3,
			{
				timeoutMs: 500,
			},
		);

		const traceFrames = frames.filter((f) => f.event === "trace");
		expect(traceFrames).toHaveLength(3);

		const names = traceFrames.map(
			(f) => (JSON.parse(f.data) as { trace: TraceRow }).trace.name,
		);
		expect(names).toEqual(["a", "b", "c"]);

		const ids = traceFrames.map(
			(f) => (JSON.parse(f.data) as { trace: TraceRow }).trace.trace_id,
		);
		expect(ids).toEqual([
			"t1".padEnd(32, "0"),
			"t2".padEnd(32, "0"),
			"t3".padEnd(32, "0"),
		]);

		await reader.cancel();
	});

	it(":ok\n\n is the first frame written", async () => {
		const res = await apiApp.fetch(
			new Request("http://x/v1/traces/events", {
				method: "GET",
				headers: { authorization: AUTH },
			}),
		);
		const reader = res.body!.getReader();
		const { value } = await reader.read();
		expect(decoder.decode(value)).toBe(":ok\n\n");
		await reader.cancel();
	});
});

// ---------------------------------------------------------------------------
// 3. /v1/traces/{id}/events — multi-client dispatch (AC8)
// ---------------------------------------------------------------------------

describe("GET /v1/traces/{id}/events (detail SSE)", () => {
	it("two parallel SSE clients both receive the same observation (AC8 multi-client)", async () => {
		const url = `http://x/v1/traces/${VALID_TRACE_ID}/events`;

		const resA = await apiApp.fetch(
			new Request(url, { method: "GET", headers: { authorization: AUTH } }),
		);
		const resB = await apiApp.fetch(
			new Request(url, { method: "GET", headers: { authorization: AUTH } }),
		);
		expect(resA.status).toBe(200);
		expect(resB.status).toBe(200);

		const readerA = resA.body!.getReader();
		const readerB = resB.body!.getReader();

		// Drain :ok + snapshot from both.
		await readOkAndSnapshot(readerA);
		await readOkAndSnapshot(readerB);

		const liveObs: ObservationRow = {
			...fakeObservation,
			observation_id: "multi-client-obs",
		};
		publishSync("observation.created", { observation: liveObs });

		const framesA = await readFramesUntil(readerA, (f) =>
			f.some((x) => x.event === "observation"),
		);
		const framesB = await readFramesUntil(readerB, (f) =>
			f.some((x) => x.event === "observation"),
		);

		const obsA = framesA.find((f) => f.event === "observation");
		const obsB = framesB.find((f) => f.event === "observation");
		expect(obsA).toBeDefined();
		expect(obsB).toBeDefined();
		expect(JSON.parse(obsA!.data).observation.observation_id).toBe(
			"multi-client-obs",
		);
		expect(JSON.parse(obsB!.data).observation.observation_id).toBe(
			"multi-client-obs",
		);
		expect(JSON.parse(obsA!.data).observation.trace_id).toBe(VALID_TRACE_ID);

		await readerA.cancel();
		await readerB.cancel();
	});

	it("snapshot event arrives first and contains the snapshot observations", async () => {
		const res = await apiApp.fetch(
			new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
				method: "GET",
				headers: { authorization: AUTH },
			}),
		);
		const reader = res.body!.getReader();
		await reader.read(); // :ok

		const frames = await readFramesUntil(
			reader,
			(f) => f.some((x) => x.event === "snapshot"),
			{
				timeoutMs: 500,
			},
		);
		expect(frames[0]?.event).toBe("snapshot");
		const snapshot = JSON.parse(frames[0]!.data) as {
			trace: TraceRow;
			observations: ObservationRow[];
		};
		expect(snapshot.trace).toEqual(fakeTrace);
		expect(snapshot.observations).toHaveLength(1);
		expect(snapshot.observations[0]?.observation_id).toBe("obs-it-1");

		await reader.cancel();
	});

	it("grace timer fires and stream closes after TRACE_COMPLETE_GRACE_MS", async () => {
		const res = await apiApp.fetch(
			new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
				method: "GET",
				headers: { authorization: AUTH },
			}),
		);
		const reader = res.body!.getReader();
		await readOkAndSnapshot(reader);

		// Wait for the grace timer (TRACE_COMPLETE_GRACE_MS=200) to fire.
		const frames = await readFramesUntil(
			reader,
			(f) => f.some((x) => x.event === "status"),
			{
				timeoutMs: 1_500,
			},
		);
		const statusFrame = frames.find((f) => f.event === "status");
		expect(statusFrame).toBeDefined();
		const parsed = JSON.parse(statusFrame!.data) as { status: string };
		expect(parsed.status).toBe("complete");

		// Stream should close after status. Confirm with a short read.
		const next = await Promise.race([
			reader.read(),
			new Promise<{ value: undefined; done: true }>((resolve) =>
				setTimeout(() => resolve({ value: undefined, done: true }), 200),
			),
		]);
		expect(next.done).toBe(true);
	});

	it("non-matching observations do NOT arrive on this stream (filter by trace_id)", async () => {
		const res = await apiApp.fetch(
			new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
				method: "GET",
				headers: { authorization: AUTH },
			}),
		);
		const reader = res.body!.getReader();
		await readOkAndSnapshot(reader);

		// Publish an observation for a DIFFERENT trace.
		publishSync("observation.created", {
			observation: {
				...fakeObservation,
				trace_id: "ffffffffffffffffffffffffffffffff",
				observation_id: "other-trace",
			},
		});

		// No observation frame should arrive. Eventually the grace timer fires
		// and writes a status frame.
		const frames = await readFramesUntil(
			reader,
			(f) => f.some((x) => x.event === "status"),
			{
				timeoutMs: 1_000,
			},
		);
		const observationFrames = frames.filter((f) => f.event === "observation");
		expect(observationFrames).toHaveLength(0);
		expect(frames.find((f) => f.event === "status")).toBeDefined();

		await reader.cancel();
	});

	it("404 when trace doesn't exist — JSON response (no SSE upgrade)", async () => {
		getTraceMock.mockResolvedValueOnce({ trace: null, observations: [] });
		const res = await apiApp.fetch(
			new Request(`http://x/v1/traces/${"0".repeat(32)}/events`, {
				method: "GET",
				headers: { authorization: AUTH },
			}),
		);
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toMatch(/application\/json/);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("NOT_FOUND");
	});
});

// ---------------------------------------------------------------------------
// 4. /v1/observations/events — metadata envelope
// ---------------------------------------------------------------------------

describe("GET /v1/observations/events (spans SSE)", () => {
	it("published observation arrives with metadataParsed as a typed envelope", async () => {
		const res = await apiApp.fetch(
			new Request("http://x/v1/observations/events", {
				method: "GET",
				headers: { authorization: AUTH },
			}),
		);
		expect(res.status).toBe(200);

		const reader = res.body!.getReader();
		await reader.read(); // :ok

		publishSync("observation.created", { observation: fakeObservation });

		const frames = await readFramesUntil(reader, (f) =>
			f.some((x) => x.event === "observation"),
		);
		const obsFrame = frames.find((f) => f.event === "observation");
		expect(obsFrame).toBeDefined();
		const parsed = JSON.parse(obsFrame!.data) as {
			observation: ObservationRow;
			metadataParsed: unknown;
		};
		expect(parsed.observation.observation_id).toBe("obs-it-1");
		expect(parsed.metadataParsed).toEqual({
			schema_version: 1,
			attributes: [
				{ key: "model", value: { stringValue: "gpt-4o" } },
				{ key: "tokens", value: { intValue: 7 } },
			],
			prompt_provenance: null,
		});

		await reader.cancel();
	});
});
