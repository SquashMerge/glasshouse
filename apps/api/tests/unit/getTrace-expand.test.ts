// Verifies that GET /v1/traces/{id} with ?expand=metadata parses each
// observation's metadata JSON column into an object (or null on parse
// failure), and that without the flag the response is unchanged (raw
// string metadata).

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { Context } from "hono";
import type { TraceRow, ObservationRow } from "../../src/db/traces-query";

const VALID_TRACE_ID = "0123456789abcdef0123456789abcdef";
const META_JSON = JSON.stringify({ model: "gpt-4o", tokens: 42 });
const META_BAD = "{not valid json";

const fakeTrace: TraceRow = {
  trace_id: VALID_TRACE_ID,
  project_id: "proj-1",
  name: "test",
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

const fakeObservations: ObservationRow[] = [
  {
    observation_id: "obs-1",
    trace_id: VALID_TRACE_ID,
    project_id: "proj-1",
    parent_observation_id: null,
    type: "generation",
    name: "ok-span",
    start_time: "2024-01-01 00:00:00.000",
    end_time: null,
    duration_ms: null,
    status: "ok",
    model: "gpt-4o",
    input_text: "",
    output_text: "",
    metadata: META_JSON,
  },
  {
    observation_id: "obs-2",
    trace_id: VALID_TRACE_ID,
    project_id: "proj-1",
    parent_observation_id: null,
    type: "span",
    name: "broken-meta",
    start_time: "2024-01-01 00:00:00.500",
    end_time: null,
    duration_ms: null,
    status: "ok",
    model: null,
    input_text: "",
    output_text: "",
    metadata: META_BAD,
  },
  {
    observation_id: "obs-3",
    trace_id: VALID_TRACE_ID,
    project_id: "proj-1",
    parent_observation_id: null,
    type: "span",
    name: "empty-meta",
    start_time: "2024-01-01 00:00:01.000",
    end_time: null,
    duration_ms: null,
    status: "ok",
    model: null,
    input_text: "",
    output_text: "",
    metadata: "",
  },
];

const getTraceMock = mock(async () => ({ trace: fakeTrace, observations: fakeObservations }));
const defaultClientMock = mock(() => ({}));

mock.module("../../src/db/traces-query", () => ({
  defaultClient: defaultClientMock,
  getTrace: getTraceMock,
  listTraces: mock(async () => ({ items: [], total: 0 })),
  listObservations: mock(async () => ({ items: [], total: 0 })),
}));

const { handleGetTrace } = await import("../../src/routes/traces");

beforeEach(() => {
  getTraceMock.mockClear();
  defaultClientMock.mockClear();
});

function fakeContext(opts: { traceId: string; expand?: string }): Context {
  const url = new URL(`http://x/v1/traces/${opts.traceId}`);
  if (opts.expand) url.searchParams.set("expand", opts.expand);
  const req = new Request(url.toString(), { method: "GET" });
  return {
    req: {
      valid: () => ({ id: opts.traceId }),
      query: (name: string) =>
        name === "expand" ? (opts.expand ?? undefined) : undefined,
      raw: req,
    },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as unknown as Context;
}

describe("handleGetTrace ?expand=metadata", () => {
  it("without ?expand=metadata, observation.metadata is the raw string (unchanged)", async () => {
    getTraceMock.mockResolvedValueOnce({
      trace: fakeTrace,
      observations: fakeObservations,
    });

    const res = await handleGetTrace(fakeContext({ traceId: VALID_TRACE_ID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trace: TraceRow;
      observations: Array<{ observation_id: string; metadata: unknown }>;
    };
    expect(body.observations).toHaveLength(3);
    const obs1 = body.observations.find((o) => o.observation_id === "obs-1");
    expect(obs1?.metadata).toBe(META_JSON); // raw string
    expect(typeof obs1?.metadata).toBe("string");
    const obs2 = body.observations.find((o) => o.observation_id === "obs-2");
    expect(obs2?.metadata).toBe(META_BAD); // raw string (broken)
    const obs3 = body.observations.find((o) => o.observation_id === "obs-3");
    expect(obs3?.metadata).toBe(""); // empty string
  });

  it("with ?expand=metadata, observation.metadata is parsed JSON object", async () => {
    getTraceMock.mockResolvedValueOnce({
      trace: fakeTrace,
      observations: fakeObservations,
    });

    const res = await handleGetTrace(
      fakeContext({ traceId: VALID_TRACE_ID, expand: "metadata" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trace: TraceRow;
      observations: Array<{ observation_id: string; metadata: unknown }>;
    };
    expect(body.observations).toHaveLength(3);
    const obs1 = body.observations.find((o) => o.observation_id === "obs-1");
    expect(obs1?.metadata).toEqual({ model: "gpt-4o", tokens: 42 });
  });

  it("with ?expand=metadata, malformed JSON metadata becomes null (not 500)", async () => {
    getTraceMock.mockResolvedValueOnce({
      trace: fakeTrace,
      observations: fakeObservations,
    });

    const res = await handleGetTrace(
      fakeContext({ traceId: VALID_TRACE_ID, expand: "metadata" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      observations: Array<{ observation_id: string; metadata: unknown }>;
    };
    const obs2 = body.observations.find((o) => o.observation_id === "obs-2");
    expect(obs2?.metadata).toBeNull();
  });

  it("with ?expand=metadata, empty metadata string becomes null", async () => {
    getTraceMock.mockResolvedValueOnce({
      trace: fakeTrace,
      observations: fakeObservations,
    });

    const res = await handleGetTrace(
      fakeContext({ traceId: VALID_TRACE_ID, expand: "metadata" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      observations: Array<{ observation_id: string; metadata: unknown }>;
    };
    const obs3 = body.observations.find((o) => o.observation_id === "obs-3");
    expect(obs3?.metadata).toBeNull();
  });

  it("with ?expand=other (not 'metadata'), behavior is unchanged (no parse)", async () => {
    getTraceMock.mockResolvedValueOnce({
      trace: fakeTrace,
      observations: fakeObservations,
    });

    const res = await handleGetTrace(
      fakeContext({ traceId: VALID_TRACE_ID, expand: "something-else" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      observations: Array<{ metadata: unknown }>;
    };
    expect(body.observations[0]?.metadata).toBe(META_JSON); // raw string
    expect(typeof body.observations[0]?.metadata).toBe("string");
  });

  it("404 when trace not found", async () => {
    getTraceMock.mockResolvedValueOnce({ trace: null, observations: [] });

    const res = await handleGetTrace(
      fakeContext({ traceId: VALID_TRACE_ID, expand: "metadata" }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NOT_FOUND");
  });
});