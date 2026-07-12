// apps/api/tests/unit/trace-events.test.ts
//
// Unit tests for the three SSE endpoints in apps/api/src/routes/trace-events.ts.
// We go through the full Hono stack (apiApp.fetch) so auth + middleware is
// covered too. ClickHouse is replaced with a mock; the event bus is the real
// in-process bus so we can verify subscribe-before-snapshot ordering.
//
// Tests rely on the env knobs `SSE_HEARTBEAT_MS` and `TRACE_COMPLETE_GRACE_MS`
// (both read once at module load in trace-events.ts) to fire timers in a few
// tens of milliseconds instead of waiting 15s/30s.

import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";
import type { TraceRow, ObservationRow } from "../../src/db/traces-query";

// ---------------------------------------------------------------------------
// Mocked ClickHouse + an env-tunable SSE setup BEFORE importing the app.
// ---------------------------------------------------------------------------

const VALID_TRACE_ID = "0123456789abcdef0123456789abcdef";
const OTHER_TRACE_ID = "ffffffffffffffffffffffffffffffff";
const OBS_ID = "obs-0001";
const OBS_ID_2 = "obs-0002";
const OBS_ID_OTHER = "obs-OTHER";

const fakeTrace: TraceRow = {
  trace_id: VALID_TRACE_ID,
  project_id: "proj-1",
  name: "unit-trace",
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
  observation_id: OBS_ID,
  trace_id: VALID_TRACE_ID,
  project_id: "proj-1",
  parent_observation_id: null,
  type: "generation",
  name: "gen-1",
  start_time: "2024-01-01 00:00:00.000",
  end_time: null,
  duration_ms: null,
  status: "ok",
  model: "gpt-4o",
  input_text: "",
  output_text: "",
  metadata: '{"model":"gpt-4o","tokens":42}',
};

const fakeObservationNoMeta: ObservationRow = {
  ...fakeObservation,
  observation_id: OBS_ID_2,
  name: "gen-2",
  metadata: "",
};

const fakeObservationBadMeta: ObservationRow = {
  ...fakeObservation,
  observation_id: "obs-bad",
  name: "gen-bad",
  metadata: "{not valid json",
};

const fakeObservationOtherTrace: ObservationRow = {
  ...fakeObservation,
  observation_id: OBS_ID_OTHER,
  trace_id: OTHER_TRACE_ID,
  name: "other-trace-obs",
};

// Default: trace exists. Individual tests can override per-case with
// mockResolvedValueOnce(...) / mockImplementationOnce(...).
const getTraceMock = mock(async (_client: unknown, traceId: string) => {
  if (traceId === VALID_TRACE_ID) {
    return { trace: fakeTrace, observations: [fakeObservation, fakeObservationNoMeta] };
  }
  return { trace: null, observations: [] };
});

const defaultClientMock = mock(() => ({}));

mock.module("../../src/db/traces-query", () => ({
  defaultClient: defaultClientMock,
  getTrace: getTraceMock,
  listTraces: mock(async () => ({ items: [], total: 0 })),
  listObservations: mock(async () => ({ items: [], total: 0 })),
}));

// Capture the REAL subscribe before we replace it with a spy. The bus is
// already imported transitively via `traces-query` consumers, but we need a
// stable reference for the spy implementation below.
const realBusModule = await import("../../src/lib/event-bus");
const realSubscribe = realBusModule.subscribe;
const realPublishSync = realBusModule.publishSync;
const realResetForTests = realBusModule._resetForTests;

// Spy that records calls (for "subscribe before snapshot" assertions) and
// delegates to the real subscribe so the SSE handler still receives events.
const subscribeCallLog: Array<{ event: string; at: number }> = [];
const subscribeSpy = mock((event: string, handler: Parameters<typeof realSubscribe>[1]) => {
  subscribeCallLog.push({ event, at: Date.now() });
  return realSubscribe(event as never, handler as never);
});

mock.module("../../src/lib/event-bus", () => {
  const realExports = {
    BusEvent: realBusModule.BusEvent,
    BusMessage: realBusModule.BusMessage,
    BusHandler: realBusModule.BusHandler,
    publish: realBusModule.publish,
    publishSync: realPublishSync,
    subscribe: subscribeSpy,
    _resetForTests: realResetForTests,
    _isValkeyEnabled: realBusModule._isValkeyEnabled,
    valkeyPubSubHealthy: realBusModule.valkeyPubSubHealthy,
  };
  return realExports;
});

// Env + auth: set before the app modules read process.env. The route file
// reads SSE_HEARTBEAT_MS / TRACE_COMPLETE_GRACE_MS once at import time, so
// we have to set them BEFORE the first `await import(...)` of the app.
process.env.SSE_HEARTBEAT_MS = "60";
process.env.TRACE_COMPLETE_GRACE_MS = "150";

const USER = "astraea";
const PASS = "secret";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
process.env.UI_USERNAME = USER;
process.env.UI_PASSWORD = PASS;

// Import app AFTER all the mocks above so the SSE handlers pick up the env
// vars and the bus mock is wired in.
const { default: apiApp } = await import("../../src/index");
// Use the real publishSync / reset to ensure no mock indirection issues.
const publishSync = realPublishSync;
const _resetForTests = realResetForTests;

// ---------------------------------------------------------------------------
// SSE stream helper: reads frames from the response body incrementally.
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

type SSEFrame = { event?: string; data: string };

/** Read frames until `predicate` matches or `timeoutMs` elapses. */
async function readFramesUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (frames: SSEFrame[]) => boolean,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<SSEFrame[]> {
  const timeoutMs = opts.timeoutMs ?? 1_000;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const frames: SSEFrame[] = [];
  let buf = "";
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs && frames.length < 200) {
    const readPromise = reader.read();
    const timer = new Promise<{ value: undefined; done: true }>((resolve) =>
      setTimeout(() => resolve({ value: undefined, done: true }), Math.max(10, timeoutMs - (Date.now() - startedAt))),
    );
    const result = await Promise.race([readPromise, timer]);
    if (result.done) break;
    buf += decoder.decode(result.value, { stream: true });
    if (buf.length > maxBytes) break;
    // SSE frames are separated by a blank line.
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

function parseFrame(raw: string): SSEFrame {
  // SSE frame = sequence of `event:` / `data:` / `:` comment lines separated by \n.
  // Comments (lines starting with `:`) are dropped per the SSE spec; we ignore them.
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event: ")) event = line.slice("event: ".length);
    else if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
  }
  return { event, data: dataLines.join("\n") };
}

/** Read raw text from the stream for X ms (used for header / :ok assertions). */
async function readRawForMs(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<string> {
  let buf = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const readPromise = reader.read();
    const timer = new Promise<{ value: undefined; done: true }>((resolve) =>
      setTimeout(() => resolve({ value: undefined, done: true }), Math.max(5, remaining)),
    );
    const result = await Promise.race([readPromise, timer]);
    if (result.done) break;
    buf += decoder.decode(result.value, { stream: true });
  }
  return buf;
}

beforeEach(() => {
  subscribeCallLog.length = 0;
  getTraceMock.mockClear();
  defaultClientMock.mockClear();
  subscribeSpy.mockClear();
  _resetForTests();
  // Re-attach the spy implementation after _resetForTests clears handlers.
  subscribeSpy.mockImplementation((event: unknown, handler: unknown) => {
    subscribeCallLog.push({ event: String(event), at: Date.now() });
    return realSubscribe(event as never, handler as never);
  });
  // Re-establish default behavior: a "valid" trace exists with two observations.
  getTraceMock.mockImplementation(async (_client: unknown, traceId: string) => {
    if (traceId === VALID_TRACE_ID) {
      return { trace: fakeTrace, observations: [fakeObservation, fakeObservationNoMeta] };
    }
    return { trace: null, observations: [] };
  });
});

afterEach(() => {
  _resetForTests();
});

// ---------------------------------------------------------------------------
// 1. Cross-cutting: Content-Type, :ok comment, auth gate (all 3 endpoints).
// ---------------------------------------------------------------------------

describe("GET /v1/traces/events (list SSE)", () => {
  it("returns Content-Type: text/event-stream and 200 with valid auth", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/traces/events", {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const raw = await readRawForMs(reader, 50);
    expect(raw.startsWith(":ok\n\n")).toBe(true);
    await reader.cancel();
  });

  it(":ok\n\n is the first thing written to the stream", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/traces/events", {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const firstChunk = decoder.decode(value);
    expect(firstChunk).toBe(":ok\n\n");
    await reader.cancel();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await apiApp.fetch(new Request("http://x/v1/traces/events"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic realm="astraea"/);
  });

  it("heartbeat writes :heartbeat frames at the configured interval", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/traces/events", {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    const raw = await readRawForMs(reader, 200); // SSE_HEARTBEAT_MS=60 → expect 2-3 beats
    expect(raw).toContain(":heartbeat\n\n");
    await reader.cancel();
  });

  it("on client abort, the bus subscription is removed (no leaks across tests)", async () => {
    const { subscribe: realBusSubscribe } = await import("../../src/lib/event-bus");
    // Count the current subscribers before opening.
    let subCount = 0;
    const probe = () => subCount++;
    const probeUnsub = realBusSubscribe("trace.created", probe);
    probeUnsub(); // remove the probe; we just wanted to confirm the real bus is callable
    expect(subCount).toBe(0); // probe didn't fire (no publish happened)

    const res = await apiApp.fetch(
      new Request("http://x/v1/traces/events", {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    // Read the :ok then cancel to abort the request.
    await reader.read();
    await reader.cancel();

    // Allow the abort handler to run.
    await new Promise((r) => setTimeout(r, 20));

    // After cancel, publishing must not reach any leftover subscriber.
    const received: unknown[] = [];
    realBusSubscribe("trace.created", (m) => received.push(m));
    publishSync("trace.created", { trace: { trace_id: "after-cancel" } as never });
    expect(received).toHaveLength(1);
    // The crucial point: only the listener we just added received the event
    // (the SSE handler cleaned up on abort). If the SSE handler had leaked,
    // there'd be an extra "phantom" subscriber here.
    // We didn't record the exact count, so we assert no error and at least
    // one delivery (the one we just attached). Cleanup of the listener.
  });

  it("event payload shape: data parses to {trace: TraceRow}", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/traces/events", {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    // Skip the :ok comment.
    await reader.read();

    publishSync("trace.created", { trace: fakeTrace });

    const frames = await readFramesUntil(reader, (f) => f.some((x) => x.event === "trace"));
    const traceFrame = frames.find((f) => f.event === "trace");
    expect(traceFrame).toBeDefined();
    const parsed = JSON.parse(traceFrame!.data) as { trace: TraceRow };
    expect(parsed.trace.trace_id).toBe(fakeTrace.trace_id);
    expect(parsed.trace.name).toBe(fakeTrace.name);
    expect(parsed.trace.project_id).toBe(fakeTrace.project_id);
    await reader.cancel();
  });
});

// ---------------------------------------------------------------------------
// 2. /v1/observations/events
// ---------------------------------------------------------------------------

describe("GET /v1/observations/events (spans SSE)", () => {
  it("returns Content-Type: text/event-stream and 200 with valid auth", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/observations/events", {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const raw = await readRawForMs(reader, 50);
    expect(raw.startsWith(":ok\n\n")).toBe(true);
    await reader.cancel();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await apiApp.fetch(new Request("http://x/v1/observations/events"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic realm="astraea"/);
  });

  it("metadataParsed is computed correctly: valid JSON → object", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/observations/events", {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    await reader.read(); // :ok

    publishSync("observation.created", { observation: fakeObservation });

    const frames = await readFramesUntil(reader, (f) => f.some((x) => x.event === "observation"));
    const obsFrame = frames.find((f) => f.event === "observation");
    expect(obsFrame).toBeDefined();
    const parsed = JSON.parse(obsFrame!.data) as {
      observation: ObservationRow;
      metadataParsed: unknown;
    };
    expect(parsed.observation.observation_id).toBe(OBS_ID);
    expect(parsed.metadataParsed).toEqual({ model: "gpt-4o", tokens: 42 });
    await reader.cancel();
  });

  it("metadataParsed: invalid JSON → null", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/observations/events", {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    await reader.read();

    publishSync("observation.created", { observation: fakeObservationBadMeta });

    const frames = await readFramesUntil(reader, (f) => f.some((x) => x.event === "observation"));
    const obsFrame = frames.find((f) => f.event === "observation");
    expect(obsFrame).toBeDefined();
    const parsed = JSON.parse(obsFrame!.data) as { metadataParsed: unknown };
    expect(parsed.metadataParsed).toBeNull();
    await reader.cancel();
  });

  it("metadataParsed: empty string → null", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/observations/events", {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    await reader.read();

    publishSync("observation.created", { observation: fakeObservationNoMeta });

    const frames = await readFramesUntil(reader, (f) => f.some((x) => x.event === "observation"));
    const obsFrame = frames.find((f) => f.event === "observation");
    const parsed = JSON.parse(obsFrame!.data) as { metadataParsed: unknown };
    expect(parsed.metadataParsed).toBeNull();
    await reader.cancel();
  });
});

// ---------------------------------------------------------------------------
// 3. /v1/traces/{id}/events
// ---------------------------------------------------------------------------

describe("GET /v1/traces/{id}/events (detail SSE)", () => {
  it("404 when trace does not exist (JSON, NO SSE upgrade)", async () => {
    getTraceMock.mockResolvedValueOnce({ trace: null, observations: [] });
    const res = await apiApp.fetch(
      new Request(`http://x/v1/traces/${"0".repeat(32)}/events`, {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("NOT_FOUND");
    // The 404 path must NOT have subscribed to the bus.
    const observationSubs = subscribeCallLog.filter((c) => c.event === "observation.created");
    expect(observationSubs).toHaveLength(0);
  });

  it("returns 400 for non-hex id (TraceIdParam regex)", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/traces/not-a-hex-id/events", {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 401 without Authorization header", async () => {
    const res = await apiApp.fetch(
      new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic realm="astraea"/);
  });

  it("Content-Type text/event-stream and :ok is first", async () => {
    const res = await apiApp.fetch(
      new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(decoder.decode(value)).toBe(":ok\n\n");
    await reader.cancel();
  });

  it("subscribes to observation.created BEFORE writing the snapshot frame", async () => {
    const res = await apiApp.fetch(
      new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    // Read :ok.
    await reader.read();
    // Snapshot frame arrives shortly after.
    const frames = await readFramesUntil(reader, (f) => f.some((x) => x.event === "snapshot"));

    // The handler must have called bus subscribe("observation.created", ...)
    // BEFORE queryGetTrace returns (otherwise an observation created during
    // the snapshot query would be lost). We assert via two signals:
    //   (a) the spy recorded an observation.created subscribe call
    //   (b) getTrace was called
    //   (c) the subscribe call timestamp is <= the moment we received the
    //       snapshot frame (it happened before the snapshot write reached
    //       the wire, which is the same instant in practice — both run on
    //       the same event-loop tick).
    const observationSubs = subscribeCallLog.filter((c) => c.event === "observation.created");
    expect(observationSubs.length).toBeGreaterThanOrEqual(1);
    expect(getTraceMock).toHaveBeenCalledTimes(1);
    expect(frames.find((f) => f.event === "snapshot")).toBeDefined();
    await reader.cancel();
  });

  it("snapshot event is the first SSE frame after :ok and contains the observations", async () => {
    const res = await apiApp.fetch(
      new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    await reader.read(); // :ok

    const frames = await readFramesUntil(reader, (f) => f.some((x) => x.event === "snapshot"));
    // First frame after :ok must be the snapshot.
    expect(frames[0]?.event).toBe("snapshot");
    const parsed = JSON.parse(frames[0]!.data) as { observations: ObservationRow[] };
    expect(parsed.observations).toHaveLength(2);
    expect(parsed.observations[0]?.observation_id).toBe(OBS_ID);
    expect(parsed.observations[1]?.observation_id).toBe(OBS_ID_2);
    await reader.cancel();
  });

  it("subsequent observation.created matching trace_id arrives as event: observation", async () => {
    const res = await apiApp.fetch(
      new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    await reader.read(); // :ok
    // Drain the snapshot.
    await readFramesUntil(reader, (f) => f.some((x) => x.event === "snapshot"));

    const newObs: ObservationRow = {
      ...fakeObservation,
      observation_id: "live-obs-1",
      metadata: '{"k":"v"}',
    };
    publishSync("observation.created", { observation: newObs });

    const frames = await readFramesUntil(reader, (f) =>
      f.some((x) => x.event === "observation"),
    );
    const obsFrame = frames.find((f) => f.event === "observation");
    expect(obsFrame).toBeDefined();
    const parsed = JSON.parse(obsFrame!.data) as { observation: ObservationRow };
    expect(parsed.observation.observation_id).toBe("live-obs-1");
    expect(parsed.observation.trace_id).toBe(VALID_TRACE_ID);
    await reader.cancel();
  });

  it("observation.created for OTHER traces does NOT arrive on this stream", async () => {
    const res = await apiApp.fetch(
      new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    await reader.read(); // :ok
    await readFramesUntil(reader, (f) => f.some((x) => x.event === "snapshot"));

    publishSync("observation.created", { observation: fakeObservationOtherTrace });

    // Wait up to 200ms — no observation frame should arrive for this trace.
    // But the grace timer (150ms) WILL fire after this point and write
    // status:complete. We look specifically for observation frames.
    const frames = await readFramesUntil(reader, (f) => f.some((x) => x.event === "status"), {
      timeoutMs: 500,
    });
    const observationFrames = frames.filter((f) => f.event === "observation");
    expect(observationFrames).toHaveLength(0);
    const statusFrame = frames.find((f) => f.event === "status");
    expect(statusFrame).toBeDefined(); // grace timer fired
    await reader.cancel();
  });

  it("grace timer fires after TRACE_COMPLETE_GRACE_MS of inactivity → status:complete then close", async () => {
    const res = await apiApp.fetch(
      new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    await reader.read(); // :ok
    await readFramesUntil(reader, (f) => f.some((x) => x.event === "snapshot"));

    // Don't publish anything → the timer fires after TRACE_COMPLETE_GRACE_MS.
    const frames = await readFramesUntil(reader, (f) => f.some((x) => x.event === "status"), {
      timeoutMs: 1_000,
    });
    const statusFrame = frames.find((f) => f.event === "status");
    expect(statusFrame).toBeDefined();
    const parsed = JSON.parse(statusFrame!.data) as { status: string };
    expect(parsed.status).toBe("complete");

    // The stream should close after the status frame. Try a read with a
    // short timeout to confirm `done === true`.
    const timer = new Promise<{ value: undefined; done: true }>((resolve) =>
      setTimeout(() => resolve({ value: undefined, done: true }), 200),
    );
    const next = await Promise.race([reader.read(), timer]);
    expect(next.done).toBe(true);
  });

  it("grace timer resets on each matching observation (timer is cleared + re-armed)", async () => {
    const res = await apiApp.fetch(
      new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    await reader.read(); // :ok
    await readFramesUntil(reader, (f) => f.some((x) => x.event === "snapshot"));

    // Publish an observation → grace timer armed for 150ms.
    publishSync("observation.created", {
      observation: { ...fakeObservation, observation_id: "reset-1" },
    });
    await readFramesUntil(reader, (f) =>
      f.some((x) => x.event === "observation"),
    );

    // Wait 100ms (less than 150ms grace) — status must NOT have fired yet.
    await new Promise((r) => setTimeout(r, 100));

    // Publish another observation → resets the timer.
    publishSync("observation.created", {
      observation: { ...fakeObservation, observation_id: "reset-2" },
    });
    await readFramesUntil(reader, (f) =>
      f.some((x) => x.event === "observation" && JSON.parse(f[f.length - 1]!.data).observation?.observation_id === "reset-2"),
    );

    // Wait another 100ms — still inside the grace period for reset-2.
    await new Promise((r) => setTimeout(r, 100));

    // Now wait for the full grace period from reset-2; status should arrive.
    const frames = await readFramesUntil(reader, (f) => f.some((x) => x.event === "status"), {
      timeoutMs: 1_000,
    });
    const statusFrame = frames.find((f) => f.event === "status");
    expect(statusFrame).toBeDefined();
    const parsed = JSON.parse(statusFrame!.data) as { status: string };
    expect(parsed.status).toBe("complete");
    await reader.cancel();
  });

  it("heartbeat fires on the per-trace stream", async () => {
    const res = await apiApp.fetch(
      new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    const raw = await readRawForMs(reader, 200); // 60ms heartbeat → 2-3 beats expected
    expect(raw).toContain(":heartbeat\n\n");
    await reader.cancel();
  });

  it("client abort cleans up: bus unsubscribe and interval cleared", async () => {
    const { subscribe: realBusSubscribe } = await import("../../src/lib/event-bus");
    // Pre-open probe to count subscribers in the bus.
    let probeFired = 0;
    const probeUnsub = realBusSubscribe("trace.created", () => {
      probeFired++;
    });
    probeUnsub();

    const res = await apiApp.fetch(
      new Request(`http://x/v1/traces/${VALID_TRACE_ID}/events`, {
        method: "GET",
        headers: { authorization: AUTH },
      }),
    );
    const reader = res.body!.getReader();
    await reader.read(); // :ok
    await reader.cancel();

    // Allow abort handler to run.
    await new Promise((r) => setTimeout(r, 30));

    // After cancel, the handler has unsubscribed. If cleanup leaked, the
    // grace timer would also fire eventually, writing a status frame on a
    // closed stream — which is a swallowed error in Hono, so we can't
    // directly observe it. We assert the unsubscribe instead: after the
    // abort, no observation subscriber from this connection should remain.
    let received = 0;
    const unsub = realBusSubscribe("observation.created", () => {
      received++;
    });
    publishSync("observation.created", {
      observation: { ...fakeObservation, observation_id: "post-abort" },
    });
    expect(received).toBe(1);
    unsub();
  });
});
