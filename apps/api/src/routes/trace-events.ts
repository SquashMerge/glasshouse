// apps/api/src/routes/trace-events.ts
//
// Three SSE endpoints that stream bus events to clients:
//
//   GET /v1/traces/events          → subscribe to "trace.created"
//   GET /v1/observations/events    → subscribe to "observation.created"
//   GET /v1/traces/{id}/events     → snapshot + filtered live observations,
//                                     closes after `TRACE_COMPLETE_GRACE_MS`
//                                     of no new matching observations
//
// Wire format (per the technical brief §"Implementation plan / Backend changes"):
//   - `:ok\n\n` comment written IMMEDIATELY on connect so the client leaves
//     the connecting state.
//   - `:heartbeat\n\n` comment written every `SSE_HEARTBEAT_MS` (default 15s,
//     below the AWS ALB 60s idle timeout).
//   - On client disconnect (`onAbort`): clear the heartbeat interval,
//     unsubscribe from the bus, and let the SSE handler return so Hono
//     closes the underlying writable.
//
// Auth is handled by `basicAuthMiddleware` mounted at `/v1/*` in
// `apps/api/src/index.ts:21`; the SSE endpoints inherit it via openapiApp.
// The 404 short-circuit on `/v1/traces/{id}/events` happens BEFORE
// `streamSSE` is called, so a bad trace_id never upgrades to an SSE
// connection.

import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { TraceIdParam } from "../schemas/common.js";
import { ErrorEnvelope, NotImplementedError } from "../schemas/common.js";
import { subscribe } from "../lib/event-bus.js";
import { defaultClient, getTrace as queryGetTrace } from "../db/traces-query.js";

// Tunables. Read once at module load so per-event work is allocation-free.
// `TRACE_COMPLETE_GRACE_MS` is in the pinned contract for the per-trace
// endpoint (default 30s); `SSE_HEARTBEAT_MS` matches the brief's 15s and is
// exposed as an env var only so tests can fire heartbeats on demand.
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS ?? 15_000);
const GRACE_MS = Number(process.env.TRACE_COMPLETE_GRACE_MS ?? 30_000);

// ---------------------------------------------------------------------------
// OpenAPI route definitions (response shape mirrors `getExperimentEvents`
// at `apps/api/src/routes/experiments.ts:58–66`).
// ---------------------------------------------------------------------------

const tag = "traces";

const NotFoundResponse = {
  description: "Trace not found",
  content: { "application/json": { schema: ErrorEnvelope } },
};

const StreamResponse = {
  description: "SSE stream of events",
  content: { "text/event-stream": { schema: z.string() } },
};

const BadRequestResponse = {
  description: "Bad request",
  content: { "application/json": { schema: ErrorEnvelope } },
};

export const streamTraceEvents = createRoute({
  method: "get",
  path: "/v1/traces/events",
  tags: [tag],
  summary: "SSE stream of newly created traces",
  description:
    "Subscribes to the `trace.created` bus event and emits one `event: trace` " +
    "SSE frame per published trace. Sends an `:ok` comment immediately on " +
    "connect, a `:heartbeat` comment every `SSE_HEARTBEAT_MS` (default 15s), " +
    "and cleans up the bus subscription on client disconnect.",
  security: [{ basicAuth: [] }],
  responses: {
    200: StreamResponse,
    501: { description: "Not implemented", content: { "application/json": { schema: NotImplementedError } } },
  },
});

export const streamObservationEvents = createRoute({
  method: "get",
  path: "/v1/observations/events",
  tags: [tag],
  summary: "SSE stream of newly created observations",
  description:
    "Subscribes to the `observation.created` bus event and emits one " +
    "`event: observation` SSE frame per published observation, with " +
    "`metadataParsed` computed from the in-memory observation's metadata " +
    "JSON column at write time (null on parse failure or empty string). " +
    "Sends an `:ok` comment immediately on connect and a `:heartbeat` " +
    "comment every `SSE_HEARTBEAT_MS` (default 15s).",
  security: [{ basicAuth: [] }],
  responses: {
    200: StreamResponse,
    501: { description: "Not implemented", content: { "application/json": { schema: NotImplementedError } } },
  },
});

export const streamTraceDetailEvents = createRoute({
  method: "get",
  path: "/v1/traces/{id}/events",
  tags: [tag],
  summary: "SSE stream for a single trace: snapshot + live observations + complete",
  description:
    "Validates the trace exists (404 short-circuits BEFORE the SSE upgrade), " +
    "subscribes to `observation.created` BEFORE writing the snapshot (so any " +
    "observation created in the gap is delivered as a live event), writes an " +
    "`event: snapshot` frame with the existing observations, then forwards " +
    "matching observations (`observation.trace_id === id`) as `event: observation` " +
    "frames. Each matching observation resets a `TRACE_COMPLETE_GRACE_MS` " +
    "default-30s timer; on the timer's fire the server writes " +
    "`event: status\ndata: {\"status\":\"complete\"}` and closes the stream.",
  security: [{ basicAuth: [] }],
  request: {
    params: TraceIdParam,
  },
  responses: {
    200: StreamResponse,
    400: BadRequestResponse,
    404: NotFoundResponse,
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `metadata` (a JSON-encoded string column on `ObservationRow`) into
 * an object at write time, returning `null` on parse failure or empty input.
 * Never throws — a malformed metadata string on one observation must not
 * close the stream for siblings (research risk #11).
 */
function parseMetadata(raw: string | undefined | null): unknown {
  if (!raw || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function notFoundResponse(traceId: string): Response {
  return new Response(
    JSON.stringify({
      code: "NOT_FOUND",
      message: `Trace ${traceId} not found`,
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `GET /v1/traces/events` — one `event: trace\ndata: {trace: <TraceRow>}\n\n`
 * frame per `trace.created` bus event. Stays open until the client aborts.
 */
export async function handleStreamTraceEvents(c: Context): Promise<Response> {
  return streamSSE(c, async (stream) => {
    // CRITICAL: write `:ok` synchronously before anything else so the client
    // (whether `EventSource` or the fetch-based SSE reader in
    // `useEventSource.ts`) leaves the connecting state on the first byte.
    await stream.write(":ok\n\n");

    const heartbeat = setInterval(() => {
      // Fire-and-forget; if the stream is closed Hono's writer swallows
      // the rejection internally (see Hono StreamingApi.write try/catch).
      void stream.write(":heartbeat\n\n");
    }, HEARTBEAT_MS);

    const unsubscribe = subscribe("trace.created", (msg) => {
      const trace = msg.payload.trace;
      if (!trace) return;
      void stream.writeSSE({
        event: "trace",
        data: JSON.stringify({ trace }),
      });
    });

    // Block until the client disconnects; then clean up so we don't leak
    // intervals or bus subscriptions.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
        resolve();
      });
    });
  });
}

/**
 * `GET /v1/observations/events` — one
 * `event: observation\ndata: {observation, metadataParsed}\n\n` frame per
 * `observation.created` bus event. `metadataParsed` is computed from the
 * in-memory observation's `metadata` string at write time; null on parse
 * failure or empty input. No DB round-trip.
 */
export async function handleStreamObservationEvents(c: Context): Promise<Response> {
  return streamSSE(c, async (stream) => {
    await stream.write(":ok\n\n");

    const heartbeat = setInterval(() => {
      void stream.write(":heartbeat\n\n");
    }, HEARTBEAT_MS);

    const unsubscribe = subscribe("observation.created", (msg) => {
      const observation = msg.payload.observation;
      if (!observation) return;
      const metadataParsed = parseMetadata(observation.metadata);
      void stream.writeSSE({
        event: "observation",
        data: JSON.stringify({ observation, metadataParsed }),
      });
    });

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
        resolve();
      });
    });
  });
}

/**
 * `GET /v1/traces/{id}/events` — snapshot + filtered live observations +
 * `event: status` complete after `TRACE_COMPLETE_GRACE_MS` of inactivity.
 *
 * Order of operations (pinned by the brief, see "Implementation plan /
 * Backend changes" §5):
 *   1. Validate params + check the trace exists. 404 short-circuits BEFORE
 *      `streamSSE` so a missing trace never upgrades to an SSE connection.
 *   2. Subscribe to `"observation.created"` BEFORE writing the snapshot, so
 *      any observation created during the snapshot query is delivered as a
 *      live event (the client dedupes by `observation_id`).
 *   3. Query the snapshot observations.
 *   4. Write the snapshot frame.
 *   5. On each matching observation (filter by `trace_id === id`), write
 *      an observation frame AND reset the grace timer. On the timer firing
 *      (no new matching observations for `GRACE_MS`), write a status
 *      frame and close the stream.
 *   6. On client abort: clear the grace timer, clear the heartbeat, and
 *      unsubscribe.
 */
export async function handleStreamTraceDetailEvents(c: Context): Promise<Response> {
  const traceId = c.req.valid("param").id as string;

  // (1) Short-circuit before any SSE upgrade. The brief explicitly requires
  // this — opening an SSE stream and then immediately closing it would leak
  // headers / confuse naive clients.
  let traceExists: { trace: unknown; observations: unknown[] };
  try {
    traceExists = await queryGetTrace(defaultClient(), traceId);
  } catch (err) {
    console.error(`GET /v1/traces/{id}/events snapshot query failed:`, (err as Error).message);
    return new Response(
      JSON.stringify({ code: "INTERNAL", message: "Query failed; check server logs" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
  if (!traceExists.trace) {
    return notFoundResponse(traceId);
  }

  const snapshotObservations = traceExists.observations;

  return streamSSE(c, async (stream) => {
    await stream.write(":ok\n\n");

    const heartbeat = setInterval(() => {
      void stream.write(":heartbeat\n\n");
    }, HEARTBEAT_MS);

    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let resolveWait: () => void = () => undefined;
    const waitForClose = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });

    // Defined BEFORE subscribe() so the bus callback can call it without a
    // temporal-dead-zone error. The closure captures `graceTimer` and
    // `closed` by reference, so each `armGraceTimer()` call clears the
    // pending timer and schedules a fresh one.
    const armGraceTimer = () => {
      if (graceTimer !== null) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        if (closed) return;
        closed = true;
        // Fire the final status frame, then close. Cleanup runs after we
        // resolve the outer promise below.
        void stream
          .writeSSE({
            event: "status",
            data: JSON.stringify({ status: "complete" }),
          })
          .finally(() => {
            clearInterval(heartbeat);
            unsubscribe();
            if (graceTimer !== null) {
              clearTimeout(graceTimer);
              graceTimer = null;
            }
            resolveWait();
          });
      }, GRACE_MS);
    };

    // (2) Subscribe BEFORE the snapshot write. The closure captures
    // `graceTimer` by reference so we can reset it on each matching event.
    const unsubscribe = subscribe("observation.created", (msg) => {
      if (closed) return;
      const observation = msg.payload.observation;
      if (!observation || observation.trace_id !== traceId) return;

      // Reset the complete timer — only matching observations keep the
      // stream alive.
      armGraceTimer();

      // Forward the matching observation to the client.
      void stream.writeSSE({
        event: "observation",
        data: JSON.stringify({ observation }),
      });
    });

    // Client disconnect — clear everything so we don't leak.
    stream.onAbort(() => {
      if (closed) return;
      closed = true;
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      clearInterval(heartbeat);
      unsubscribe();
      resolveWait();
    });

    // (4) Snapshot frame. We wrote the snapshot AFTER subscribing, so any
    // observation that arrived during the snapshot query may also appear
    // here (or as a live event — the client dedupes by `observation_id`).
    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify({ observations: snapshotObservations }),
    });

    // Arm the grace timer right after the snapshot so that a trace with NO
    // further matching observations still flips to "complete" — the brief
    // (§"Implementation plan / Backend changes" item 5) defines the grace
    // as "no new events for `graceMs`". The first matching observation
    // (above) clears + re-arms it.
    armGraceTimer();

    // Keep the stream alive until either:
    //   - the client disconnects (onAbort → resolveWait)
    //   - the grace timer fires after no matching observation for GRACE_MS
    await waitForClose;
  });
}
