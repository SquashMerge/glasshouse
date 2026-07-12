import * as React from "react";

/**
 * Stub for `fe-filterable-refactor`; real implementation lands in `fe-hooks`
 * slice (slice 4).
 *
 * The real hook is a thin wrapper over `useEventSource` that decodes the
 * trace/observation payloads (`TraceEvent` / `ObservationEvent`) typed against
 * the backend's SSE schema, plus a `pause()` toggle for when the page is
 * hidden behind another tab or the user toggles a "pause live" affordance.
 *
 * For this slice the stub returns a closed connection so call sites compile.
 * Tests for this slice stub `useTraceStream` directly.
 */

import { type EventSourceStatus } from "./useEventSource";

export interface TraceStreamHandlers<T> {
  /** Called for each parsed event payload. */
  onEvent: (event: T) => void;
  /** Optional status-change observer. */
  onStatusChange?: (status: EventSourceStatus) => void;
}

export interface UseTraceStreamResult {
  status: EventSourceStatus;
  paused: boolean;
  pause: () => void;
  resume: () => void;
  lastEventAt: number | null;
}

export function useTraceStream<T>(
  _url: string,
  _handlers: TraceStreamHandlers<T>,
): UseTraceStreamResult {
  void React;
  return {
    status: "closed",
    paused: false,
    pause: () => {},
    resume: () => {},
    lastEventAt: null,
  };
}