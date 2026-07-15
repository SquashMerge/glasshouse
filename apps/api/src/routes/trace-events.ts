import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { TraceIdParam } from "../schemas/common.js";
import { ErrorEnvelope } from "../schemas/common.js";
import { subscribe } from "../lib/event-bus.js";
import { defaultClient, getTrace as queryGetTrace } from "../db/traces-query.js";
import type { NormalizedObservation } from "../db/gen-ai-attrs.js";
import {
  presentObservationMetadata,
  type ObservationMetadata,
} from "../db/observation-metadata.js";

// Read tunables once at module load so per-event work is allocation-free.
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS ?? 15_000);
const GRACE_MS = Number(process.env.TRACE_COMPLETE_GRACE_MS ?? 30_000);

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
    "a typed versioned metadata envelope and nullable prompt provenance. " +
    "Sends an `:ok` comment immediately on connect and a `:heartbeat` " +
    "comment every `SSE_HEARTBEAT_MS` (default 15s).",
  security: [{ basicAuth: [] }],
  responses: {
    200: StreamResponse,
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
 * Normalize storage and live observations to the same external metadata
 * envelope. Invalid persisted metadata intentionally fails closed.
 */
function presentObservation<T extends { type: string; metadata: string | ObservationMetadata }>(observation: T) {
  return {
    ...observation,
    metadata: presentObservationMetadata(observation.metadata, observation.type === "generation"),
  };
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
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let resolveWait: () => void = () => undefined;
    const waitForAbort = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    const cleanup = () => {
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      unsubscribe?.();
      unsubscribe = null;
      resolveWait();
    };
    stream.onAbort(cleanup);
    if (stream.aborted) {
      cleanup();
      return;
    }

    unsubscribe = subscribe("trace.created", (msg) => {
      const trace = msg.payload.trace;
      if (!trace) return;
      void stream.writeSSE({
        event: "trace",
        data: JSON.stringify({ trace }),
      });
    });
    heartbeat = setInterval(() => {
      void stream.write(":heartbeat\n\n");
    }, HEARTBEAT_MS);

    await stream.write(":ok\n\n");
    if (stream.aborted) cleanup();
    await waitForAbort;
  });
}

/**
 * `GET /v1/observations/events` — one
 * `event: observation\ndata: {observation, metadataParsed}\n\n` frame per
 * `observation.created` bus event. Both metadata fields use the typed
 * metadata envelope without a DB round-trip.
 */
export async function handleStreamObservationEvents(c: Context): Promise<Response> {
  return streamSSE(c, async (stream) => {
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let resolveWait: () => void = () => undefined;
    const waitForAbort = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    const cleanup = () => {
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      unsubscribe?.();
      unsubscribe = null;
      resolveWait();
    };
    stream.onAbort(cleanup);
    if (stream.aborted) {
      cleanup();
      return;
    }

    unsubscribe = subscribe("observation.created", (msg) => {
      const observation = msg.payload.observation;
      if (!observation) return;
      const presented = presentObservation(observation);
      void stream.writeSSE({
        event: "observation",
        data: JSON.stringify({ observation: presented, metadataParsed: presented.metadata }),
      });
    });
    heartbeat = setInterval(() => {
      void stream.write(":heartbeat\n\n");
    }, HEARTBEAT_MS);

    await stream.write(":ok\n\n");
    if (stream.aborted) cleanup();
    await waitForAbort;
  });
}

/**
 * `GET /v1/traces/{id}/events` — snapshot + filtered live observations +
 * `event: status` complete after `TRACE_COMPLETE_GRACE_MS` of inactivity.
 *
 * Order of operations (pinned by the brief, see "Implementation plan /
 * Backend changes" §5):
 *   1. Validate params, then subscribe to `"observation.created"` before the
 *      snapshot query. Matching events are buffered until the snapshot is
 *      written, so the query gap cannot lose observations.
 *   2. Query the trace. A missing trace unsubscribes and returns 404 before
 *      `streamSSE` upgrades the response.
 *   3. Capture the snapshot observations.
 *   4. Write the snapshot frame.
 *   5. On each matching observation (filter by `trace_id === id`), write
 *      an observation frame AND reset the grace timer. On the timer firing
 *      (no new matching observations for `GRACE_MS`), write a status
 *      frame and close the stream.
 *   6. On client abort: clear the grace timer, clear the heartbeat, and
 *      unsubscribe.
 */
export async function handleStreamTraceDetailEvents(c: Context): Promise<Response> {
  const traceId = c.req.param("id");

  const bufferedObservations: NormalizedObservation[] = [];
  let forwardObservation: ((observation: NormalizedObservation) => void) | null = null;
  const unsubscribe = subscribe("observation.created", (msg) => {
    const observation = msg.payload.observation;
    if (!observation || observation.trace_id !== traceId) return;
    if (forwardObservation) forwardObservation(observation);
    else bufferedObservations.push(observation);
  });

  let traceExists: Awaited<ReturnType<typeof queryGetTrace>>;
  try {
    traceExists = await queryGetTrace(defaultClient(), traceId);
  } catch (err) {
    unsubscribe();
    console.error(`GET /v1/traces/{id}/events snapshot query failed:`, (err as Error).message);
    return new Response(
      JSON.stringify({ code: "INTERNAL", message: "Query failed; check server logs" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
  if (!traceExists.trace) {
    unsubscribe();
    return notFoundResponse(traceId);
  }

  const snapshotObservations = traceExists.observations.map(presentObservation);

  return streamSSE(c, async (stream) => {
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let cleaned = false;
    let resolveWait: () => void = () => undefined;
    const waitForClose = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      closed = true;
      if (graceTimer !== null) clearTimeout(graceTimer);
      graceTimer = null;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      forwardObservation = null;
      unsubscribe();
      resolveWait();
    };
    stream.onAbort(cleanup);
    if (stream.aborted) {
      cleanup();
      return;
    }

    heartbeat = setInterval(() => {
      void stream.write(":heartbeat\n\n");
    }, HEARTBEAT_MS);
    await stream.write(":ok\n\n");
    if (stream.aborted) {
      cleanup();
      return;
    }

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
          .finally(cleanup);
      }, GRACE_MS);
    };

    const sendObservation = (observation: NormalizedObservation) => {
      if (closed) return;
      armGraceTimer();
      void stream.writeSSE({
        event: "observation",
        data: JSON.stringify({ observation: presentObservation(observation) }),
      });
    };

    // (4) Snapshot frame. We wrote the snapshot AFTER subscribing, so any
    // observation that arrived during the snapshot query may also appear
    // here (or as a live event — the client dedupes by `observation_id`).
    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify({ observations: snapshotObservations }),
    });

    forwardObservation = sendObservation;
    for (const observation of bufferedObservations.splice(0)) sendObservation(observation);

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
