import * as React from "react";
import { authedFetch } from "../lib/auth";

/**
 * `useEventSource` — fetch-based SSE hook with auth header injection.
 *
 * **Why not native `EventSource`?** The server's `basicAuthMiddleware`
 * requires an `Authorization` header, but the browser's `EventSource`
 * cannot attach custom headers. We therefore open the SSE stream via
 * `authedFetch` (which injects `Authorization: Basic …` from
 * `localStorage`) and parse the `ReadableStream<Uint8Array>` body as
 * `text/event-stream` frames.
 *
 * **Visible-state machine**: `"connecting"` → `"open"` → `"closed"`.
 * `paused: boolean` is orthogonal: `true` only when the caller explicitly
 * suppressed auto-reconnect (Pause/Resume case). Visibility-driven
 * auto-close flips `paused` back to `false` so the next `visible` event
 * resumes cleanly.
 *
 * **RAF coalescing**: incoming frames accumulate in a ref buffer; a single
 * `requestAnimationFrame` drains the buffer into `onMessage(msg)` calls
 * with a 100 ms floor (via `lastFlushAt` time guard) so a 1 kHz burst only
 * schedules ~10 flushes / second.
 *
 * **Reconnect**: exponential backoff `1s, 2s, 4s, 8s, 16s, 30s cap`,
 * reset to 1s on a successful reconnect.
 *
 * **Visibility-aware**: tab hidden >60 s → close stream, set `paused: false`;
 * tab visible → reconnect immediately. The 60 s threshold avoids churn on
 * quick tab switches.
 */

export type EventSourceStatus = "connecting" | "open" | "closed";

export interface EventSourceFrame<T> {
  event: string;
  data: T;
}

export interface UseEventSourceOptions<T> {
  /** Required: invoked once per parsed SSE frame. */
  onMessage: (msg: EventSourceFrame<T>) => void;
  /** Called once the connection transitions to `"open"`. */
  onOpen?: () => void;
  /** Called when a non-fatal stream error or JSON.parse failure occurs. */
  onError?: (err: unknown) => void;
  /** When `false`, no stream is opened. Default `true`. */
  enabled?: boolean;
}

export interface UseEventSourceResult {
  status: EventSourceStatus;
  paused: boolean;
  lastEventAt: number | null;
  /**
   * Manual reconnect.
   *  - `{ pause: true }` — enter user-paused state; suppress reconnects until called again without `pause`.
   *  - `{ pause: false }` (default) — leave user-paused state and immediately reconnect.
   *  - no args (legacy) — equivalent to `{ pause: false }`.
   */
  reconnect: (opts?: { pause?: boolean }) => void;
}

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const HIDDEN_CLOSE_THRESHOLD_MS = 60_000;
const COALESCE_WINDOW_MS = 100;

export function useEventSource<T = unknown>(
  url: string,
  options: UseEventSourceOptions<T>,
): UseEventSourceResult {
  const { onMessage, onOpen, onError, enabled = true } = options;

  const [status, setStatus] = React.useState<EventSourceStatus>("connecting");
  const [paused, setPaused] = React.useState<boolean>(false);
  const [lastEventAt, setLastEventAt] = React.useState<number | null>(null);

  // Refs to keep the latest callbacks accessible inside async stream loops
  // without re-running the connection effect every render.
  const onMessageRef = React.useRef(onMessage);
  const onOpenRef = React.useRef(onOpen);
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    onMessageRef.current = onMessage;
    onOpenRef.current = onOpen;
    onErrorRef.current = onError;
  });

  // User-pause flag (distinct from network-error "closed" state).
  const userPausedRef = React.useRef<boolean>(false);
  // Auto-closed-by-visibility flag. When true, the hook will reconnect on the
  // next `visible` event. Tracks `paused` in returned state to `false`.
  const autoHiddenClosedRef = React.useRef<boolean>(false);
  // Tracks the most recent reconnect attempt count for exponential backoff.
  const reconnectAttemptsRef = React.useRef<number>(0);
  // Holds the in-flight AbortController for the active fetch, if any.
  const abortRef = React.useRef<AbortController | null>(null);
  // Pending reconnect timer.
  const reconnectTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Visibility-close timer (fires HIDDEN_CLOSE_THRESHOLD_MS after hide).
  const hiddenCloseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp the document became hidden (null if currently visible).
  const hiddenSinceAtRef = React.useRef<number | null>(null);
  // RAF id for the pending coalesce flush.
  const rafIdRef = React.useRef<number | null>(null);
  // Last successful flush timestamp (ms via `performance.now()`).
  const lastFlushAtRef = React.useRef<number>(0);
  // Buffered messages awaiting the next coalesce flush.
  const bufferRef = React.useRef<EventSourceFrame<T>[]>([]);

  // Flag so the connect loop knows whether to keep running. Set to false on
  // unmount / enabled→false / explicit cleanup.
  const disposedRef = React.useRef<boolean>(false);

  // ---- helpers -------------------------------------------------------------

  const clearReconnectTimer = React.useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearHiddenCloseTimer = React.useCallback(() => {
    if (hiddenCloseTimerRef.current !== null) {
      clearTimeout(hiddenCloseTimerRef.current);
      hiddenCloseTimerRef.current = null;
    }
  }, []);

  const cancelRaf = React.useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const abortStream = React.useCallback(() => {
    if (abortRef.current) {
      try {
        abortRef.current.abort();
      } catch {
        // ignore — already aborted
      }
      abortRef.current = null;
    }
  }, []);

  /** Tear down any in-flight stream work without resetting user-pause state. */
  const teardown = React.useCallback(() => {
    clearReconnectTimer();
    clearHiddenCloseTimer();
    cancelRaf();
    abortStream();
    bufferRef.current = [];
  }, [abortStream, cancelRaf, clearHiddenCloseTimer, clearReconnectTimer]);

  const flushBuffer = React.useCallback(() => {
    rafIdRef.current = null;
    lastFlushAtRef.current =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const batch = bufferRef.current;
    bufferRef.current = [];
    if (batch.length === 0) return;
    const cb = onMessageRef.current;
    for (const msg of batch) cb(msg);
  }, []);

  const scheduleFlush = React.useCallback(() => {
    if (rafIdRef.current !== null) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const elapsed = now - lastFlushAtRef.current;
    if (elapsed >= COALESCE_WINDOW_MS) {
      rafIdRef.current = requestAnimationFrame(flushBuffer);
    } else {
      // Still inside the coalesce window — re-check on the next RAF.
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        scheduleFlush();
      });
    }
  }, [flushBuffer]);

  const scheduleReconnect = React.useCallback(() => {
    if (disposedRef.current) return;
    if (userPausedRef.current) return;
    if (autoHiddenClosedRef.current) return; // waits for `visible` event
    clearReconnectTimer();
    const attempt = reconnectAttemptsRef.current;
    const delay = Math.min(BACKOFF_INITIAL_MS * 2 ** attempt, BACKOFF_CAP_MS);
    reconnectAttemptsRef.current = attempt + 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void connect();
    }, delay);
  // `connect` is stable enough — defined via the same closure as below; we
  // intentionally do not include it in the deps since `connect` itself reads
  // the latest paused refs at call time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = React.useCallback(async (): Promise<void> => {
    if (disposedRef.current) return;
    if (userPausedRef.current) return;
    if (autoHiddenClosedRef.current) return;

    const ac = new AbortController();
    abortRef.current = ac;

    setStatus("connecting");

    try {
      const res = await authedFetch(url, { signal: ac.signal });
      if (!res.body) {
        throw new Error("Response has no body");
      }
      if (disposedRef.current || ac.signal.aborted) return;

      setStatus("open");
      reconnectAttemptsRef.current = 0;
      onOpenRef.current?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let carry = "";

      while (!ac.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) carry += decoder.decode(value, { stream: true });

        // Manual loop so we keep a trailing partial frame in `carry` for
        // the next chunk.
        let splitIdx: number;
        while ((splitIdx = carry.indexOf("\n\n")) !== -1) {
          const rawFrame = carry.slice(0, splitIdx);
          carry = carry.slice(splitIdx + 2);
          parseAndDispatchFrame(rawFrame);
        }
      }

      // Stream ended naturally.
      if (!ac.signal.aborted) {
        setStatus("closed");
        scheduleReconnect();
      }
    } catch (err) {
      if (ac.signal.aborted || disposedRef.current) return;
      onErrorRef.current?.(err);
      setStatus("closed");
      scheduleReconnect();
    }

    function parseAndDispatchFrame(rawFrame: string): void {
      const lines = rawFrame.split("\n");
      let eventName = "";
      const dataLines: string[] = [];
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (line.startsWith(":")) continue; // SSE comment — drop
        if (line.startsWith("event:")) {
          eventName += (eventName ? "\n" : "") + line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          // SSE allows multiple `data:` lines; concat with `\n`.
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (!eventName) return; // skip `:ok` heartbeat, no-event frames
      if (dataLines.length === 0) return;
      const dataJoined = dataLines.join("\n");
      try {
        const data = JSON.parse(dataJoined) as T;
        bufferRef.current.push({ event: eventName, data });
        setLastEventAt(Date.now());
        scheduleFlush();
      } catch (e) {
        onErrorRef.current?.(e);
      }
    }
  // `scheduleReconnect`, `scheduleFlush`, `setStatus` are stable across renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Public reconnect function: enter / leave user-paused state OR force reconnect.
  const reconnect = React.useCallback(
    (opts?: { pause?: boolean }): void => {
      if (opts?.pause) {
        userPausedRef.current = true;
        autoHiddenClosedRef.current = false;
        setPaused(true);
        teardown();
        setStatus("closed");
        return;
      }
      // Resume / manual reconnect.
      userPausedRef.current = false;
      autoHiddenClosedRef.current = false;
      setPaused(false);
      reconnectAttemptsRef.current = 0;
      teardown();
      void connect();
    },
    [connect, teardown],
  );

  // ---- primary connection effect -------------------------------------------

  React.useEffect(() => {
    if (!enabled) {
      // Subscribing is disabled — make sure nothing is open.
      teardown();
      setStatus("closed");
      return;
    }
    disposedRef.current = false;
    userPausedRef.current = false;
    autoHiddenClosedRef.current = false;
    reconnectAttemptsRef.current = 0;
    lastFlushAtRef.current = 0;
    void connect();
    return () => {
      disposedRef.current = true;
      teardown();
    };
  // Reconnect on url change per Open Q #7. `connect` is intentionally stable
  // for the lifetime of the hook and reads latest refs at call time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, url, teardown]);

  // ---- visibility-aware reconnect ------------------------------------------

  React.useEffect(() => {
    if (typeof document === "undefined") return;

    const onVisibilityChange = (): void => {
      if (document.hidden) {
        if (hiddenSinceAtRef.current === null) {
          hiddenSinceAtRef.current = Date.now();
        }
        // Schedule auto-close if we stay hidden for >60s.
        clearHiddenCloseTimer();
        hiddenCloseTimerRef.current = setTimeout(() => {
          hiddenCloseTimerRef.current = null;
          // Still hidden? Force-close.
          if (
            document.hidden &&
            hiddenSinceAtRef.current !== null &&
            Date.now() - hiddenSinceAtRef.current >= HIDDEN_CLOSE_THRESHOLD_MS
          ) {
            if (userPausedRef.current) return;
            autoHiddenClosedRef.current = true;
            // `paused` stays false so the Live indicator reads "Reconnecting".
            teardown();
            setStatus("closed");
          }
        }, HIDDEN_CLOSE_THRESHOLD_MS + 100);
        return;
      }
      // Became visible — cancel any pending auto-close and reconnect if needed.
      hiddenSinceAtRef.current = null;
      clearHiddenCloseTimer();
      if (userPausedRef.current) return;
      if (autoHiddenClosedRef.current) {
        autoHiddenClosedRef.current = false;
        reconnectAttemptsRef.current = 0;
        void connect();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearHiddenCloseTimer();
    };
  }, [clearHiddenCloseTimer, connect, teardown]);

  return { status, paused, lastEventAt, reconnect };
}
