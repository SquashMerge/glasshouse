import * as React from "react";
import { useEventSource, type EventSourceStatus } from "./useEventSource";
import type { ObservationMetadataInput } from "../lib/api";

/**
 * `useTraceStream` — thin wrapper around `useEventSource` for the detail page.
 *
 * Routes the per-trace SSE event stream:
 *   - `event: "snapshot"`     → `options.onSnapshot({observations})`
 *   - `event: "observation"`  → `options.onObservation({observation})`
 *   - `event: "status"` with `{status: "complete"}` → `options.onStatus("complete")`
 *
 * **Invalid traceId gate**: if `traceId` does not match `/^[0-9a-f]{32}$/`,
 * the hook does NOT open the stream — it schedules a synthetic
 * `onStatus("not_found")` via `queueMicrotask` so the host component can
 * render the 404 state without ever calling `authedFetch`.
 *
 * **Pause/Resume**: translate to `useEventSource.reconnect({pause})`.
 * `paused: true` only when the caller explicitly paused — auto-reconnect
 * still runs when the network drops, so the Live indicator distinguishes
 * "Paused" (user) from "Reconnecting" (network).
 *
 * Note: the returned object uses live getters that read through to the
 * underlying `useEventSource` handle. This avoids stale snapshots in tests
 * (where the mock state may change without forcing a host re-render) and
 * keeps consumer components reading the current values without manual
 * dependency wiring.
 */

const TRACE_ID_REGEX = /^[0-9a-f]{32}$/;

export interface ObservationRowLike {
  observation_id: string;
  trace_id: string;
  type?: "span" | "event" | "generation" | "tool";
  metadata?: ObservationMetadataInput;
  [k: string]: unknown;
}

export interface TraceStreamSnapshot {
  observations: ObservationRowLike[];
}

export interface TraceStreamObservation {
  observation: ObservationRowLike;
}

export interface TraceStreamStatusComplete {
  status: "complete";
}

export interface TraceStreamStatusNotFound {
  status: "not_found";
}

export type TraceStreamStatusKind = "complete" | "not_found";

export interface UseTraceStreamOptions {
  onSnapshot: (msg: TraceStreamSnapshot) => void;
  onObservation: (msg: TraceStreamObservation) => void;
  onStatus: (status: TraceStreamStatusKind) => void;
}

export interface UseTraceStreamResult {
  status: EventSourceStatus;
  paused: boolean;
  /**
   * Direct passthrough to the underlying `useEventSource.reconnect`. Pass
   * `{ pause: true }` to enter user-paused state (no reconnects until called
   * again with `pause: false`); no args (or `{ pause: false }`) to leave
   * user-paused state and reconnect immediately. The `pause` / `resume`
   * helpers below are retained for callers that prefer the explicit API.
   */
  reconnect: (opts?: { pause?: boolean }) => void;
  pause: () => void;
  resume: () => void;
  lastEventAt: number | null;
  /**
   * Diagnostic counters exposed by `useEventSource.debug`. Same shape, so the
   * `SseDebugOverlay` component can consume either hook's result directly.
   */
  debug: import("./useEventSource").UseEventSourceResult["debug"];
}

interface EnvelopeMsg {
  event: string;
  data: unknown;
}

export function useTraceStream(
  traceId: string,
  options: UseTraceStreamOptions,
): UseTraceStreamResult {
  const { onSnapshot, onObservation, onStatus } = options;

  // Keep latest callbacks accessible without retriggering the stream effect.
  const onSnapshotRef = React.useRef(onSnapshot);
  const onObservationRef = React.useRef(onObservation);
  const onStatusRef = React.useRef(onStatus);
  React.useEffect(() => {
    onSnapshotRef.current = onSnapshot;
    onObservationRef.current = onObservation;
    onStatusRef.current = onStatus;
  });

  const validTraceId = TRACE_ID_REGEX.test(traceId);

  const onMessage = React.useCallback((msg: EnvelopeMsg) => {
    switch (msg.event) {
      case "snapshot":
        onSnapshotRef.current(msg.data as TraceStreamSnapshot);
        return;
      case "observation":
        onObservationRef.current(msg.data as TraceStreamObservation);
        return;
      case "status": {
        const data = msg.data as { status?: string } | null;
        if (data && data.status === "complete") {
          onStatusRef.current("complete");
        }
        return;
      }
      default:
        // Ignore unknown event names (heartbeats etc.).
        return;
    }
  }, []);

  // Synthetic "not_found" emit when the traceId fails the regex. We schedule
  // it on a microtask so the caller's render path observes it after mount,
  // not synchronously during render.
  React.useEffect(() => {
    if (validTraceId) return;
    queueMicrotask(() => {
      onStatusRef.current("not_found");
    });
  }, [validTraceId]);

  // Open the underlying SSE stream only for valid traceIds. We still call
  // `useEventSource` unconditionally (Rules of Hooks) but with `enabled: false`
  // and a placeholder URL so no fetch is issued for invalid ids.
  const url = validTraceId
    ? `/v1/traces/${encodeURIComponent(traceId)}/events`
    : null;

  const es = useEventSource<EnvelopeMsg>(url ?? "about:blank", {
    enabled: validTraceId,
    onMessage,
  });

  const pause = React.useCallback(() => {
    es.reconnect({ pause: true });
  }, [es]);

  const resume = React.useCallback(() => {
    es.reconnect({ pause: false });
  }, [es]);

  // Live getters — read through to `es` so consumers (and tests) observe the
  // current underlying state without requiring a host re-render.
  return {
    get status() {
      return es.status;
    },
    get paused() {
      return es.paused;
    },
    get lastEventAt() {
      return es.lastEventAt;
    },
    reconnect: es.reconnect,
    get debug() {
      return es.debug;
    },
    pause,
    resume,
  };
}
