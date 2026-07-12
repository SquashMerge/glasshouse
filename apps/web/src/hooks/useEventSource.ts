import * as React from "react";

/**
 * Stub for `fe-filterable-refactor`; real implementation lands in `fe-hooks`
 * slice (slice 4).
 *
 * The real hook will:
 *   - open an authenticated EventSource-style stream via authedFetch + ReadableStream
 *     (a raw EventSource cannot carry Basic auth headers).
 *   - skip subscription when `document.visibilityState === "hidden"` and
 *     reconnect automatically when the tab becomes visible again.
 *   - coalesce incoming messages via `requestAnimationFrame` to a max flush
 *     rate of ~10 Hz (100 ms) to keep React render work bounded under load.
 *   - expose `pause()` / `resume()` and a manual `reconnect()` for ops.
 *
 * For this slice the stub returns a closed connection so the call sites compile
 * and render. Tests for this slice stub `useEventSource` directly with a fake
 * implementation that pushes events into the host component's local state.
 */

export type EventSourceStatus = "connecting" | "open" | "closed" | "error";

export interface UseEventSourceOptions {
  /** If false, the stream is not subscribed. Useful for visibility-aware pages. */
  enabled?: boolean;
  /** Called once per parsed event payload. */
  onMessage?: (data: unknown) => void;
  /** Called when the connection state changes. */
  onStatusChange?: (status: EventSourceStatus) => void;
}

export interface UseEventSourceResult {
  status: EventSourceStatus;
  paused: boolean;
  lastEventAt: number | null;
  reconnect: () => void;
}

export function useEventSource(
  _url: string,
  _options: UseEventSourceOptions = {},
): UseEventSourceResult {
  // Reference unused params so eslint/tsc noUnusedParameters stays quiet in the
  // stub without us having to plumb through real state plumbing that slice 4
  // will own end-to-end.
  void React;

  return {
    status: "closed",
    paused: false,
    lastEventAt: null,
    reconnect: () => {},
  };
}