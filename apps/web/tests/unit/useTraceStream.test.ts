/**
 * `useTraceStream` — per-trace SSE wrapper.
 *
 * Verifies:
 *  - Routes `snapshot` → `onSnapshot`, `observation` → `onObservation`,
 *    `status` with `{status:"complete"}` → `onStatus("complete")`.
 *  - Invalid traceId (regex miss): never opens the stream and emits
 *    `onStatus("not_found")` asynchronously.
 *  - `pause()` / `resume()` propagate to the underlying `useEventSource`;
 *    `paused` reflects the user-pause state.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTraceStream } from "../../src/hooks/useTraceStream";
import { EventSourceHttpError } from "../../src/hooks/useEventSource";

// ---------------------------------------------------------------------------
// Module mocks — fake useEventSource so we can drive its callback directly.
// ---------------------------------------------------------------------------

type Frame = { event: string; data: unknown };

interface FakeEventSourceHandle {
  push: (msg: Frame) => void;
  pushError: (error: unknown) => void;
  setStatus: (s: "connecting" | "open" | "closed") => void;
  setPaused: (p: boolean) => void;
  setLastEventAt: (t: number | null) => void;
  triggerReconnect: (opts?: { pause?: boolean }) => void;
  reconnectCalls: Array<{ pause?: boolean } | undefined>;
}

const handleByUrl = new Map<string, FakeEventSourceHandle>();
const lastOptionsByUrl = new Map<
	string,
	{
		enabled?: boolean;
		onMessage?: (msg: Frame) => void;
		onError?: (error: unknown) => void;
	}
>();

vi.mock("../../src/hooks/useEventSource", async () => {
  const actual = await vi.importActual<typeof import("../../src/hooks/useEventSource")>(
    "../../src/hooks/useEventSource",
  );
  return {
    ...actual,
    useEventSource: (
      url: string,
      opts: {
        enabled?: boolean;
        onMessage?: (msg: Frame) => void;
        onError?: (error: unknown) => void;
      } = {},
    ) => {
      const status = { current: "connecting" as "connecting" | "open" | "closed" };
      const paused = { current: false };
      const lastEventAt = { current: null as number | null };
      const optsRef = { current: opts };
      const handle: FakeEventSourceHandle = {
        push: (msg) => optsRef.current.onMessage?.(msg),
        pushError: (error) => optsRef.current.onError?.(error),
        setStatus: (s) => {
          status.current = s;
          // Trigger a re-render via a microtask the host picks up.
        },
        setPaused: (p) => {
          paused.current = p;
        },
        setLastEventAt: (t) => {
          lastEventAt.current = t;
        },
        triggerReconnect: (opts2) => {
          handle.reconnectCalls.push(opts2);
          if (opts2?.pause) {
            paused.current = true;
            status.current = "closed";
          } else {
            paused.current = false;
            status.current = "connecting";
          }
        },
        reconnectCalls: [],
      };
      handleByUrl.set(url, handle);
      lastOptionsByUrl.set(url, opts);
      // Capture opts ref
      optsRef.current = opts;

			return {
				get status() {
					return status.current;
				},
				get paused() {
					return paused.current;
				},
				get lastEventAt() {
					return lastEventAt.current;
				},
				reconnect: handle.triggerReconnect,
			};
		},
	};
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function flushMicrotasks(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

interface TraceStreamHandles {
	onSnapshot: ReturnType<typeof vi.fn>;
	onObservation: ReturnType<typeof vi.fn>;
	onStatus: ReturnType<typeof vi.fn>;
	result: ReturnType<
		typeof renderHook<ReturnType<typeof useTraceStream>, Record<string, never>>
	>;
}

function setupHook(traceId: string): TraceStreamHandles {
	const onSnapshot = vi.fn();
	const onObservation = vi.fn();
	const onStatus = vi.fn();
	let capturedResult!: ReturnType<typeof useTraceStream>;
	const hookResult = renderHook(
		() => {
			capturedResult = useTraceStream(traceId, {
				onSnapshot,
				onObservation,
				onStatus,
			});
			return capturedResult;
		},
		{ initialProps: {} as Record<string, never> },
	);
	return { onSnapshot, onObservation, onStatus, result: hookResult };
}

const VALID_TRACE_ID = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
	handleByUrl.clear();
	lastOptionsByUrl.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useTraceStream — routing", () => {
	it("routes event: snapshot → onSnapshot", async () => {
		const { onSnapshot } = setupHook(VALID_TRACE_ID);

		await act(async () => {
			await flushMicrotasks();
		});

		const handle = handleByUrl.get(`/v1/traces/${VALID_TRACE_ID}/events`);
		expect(handle).toBeDefined();

		act(() => {
			handle!.push({
				event: "snapshot",
				data: {
					observations: [
						{ observation_id: "obs-1" },
						{ observation_id: "obs-2" },
					],
				},
			});
		});

		expect(onSnapshot).toHaveBeenCalledTimes(1);
		expect(onSnapshot).toHaveBeenCalledWith({
			observations: [{ observation_id: "obs-1" }, { observation_id: "obs-2" }],
		});
	});

	it("preserves the optional trace in a snapshot", async () => {
		const { onSnapshot } = setupHook(VALID_TRACE_ID);

		await act(async () => {
			await flushMicrotasks();
		});

		const handle = handleByUrl.get(`/v1/traces/${VALID_TRACE_ID}/events`);
		expect(handle).toBeDefined();
		const trace = { trace_id: VALID_TRACE_ID, name: "snapshot trace" };

		act(() => {
			handle!.push({ event: "snapshot", data: { trace, observations: [] } });
		});

		expect(onSnapshot).toHaveBeenCalledWith({ trace, observations: [] });
	});

	it("routes event: observation → onObservation", async () => {
		const { onObservation } = setupHook(VALID_TRACE_ID);

		await act(async () => {
			await flushMicrotasks();
		});

		const handle = handleByUrl.get(`/v1/traces/${VALID_TRACE_ID}/events`);
		expect(handle).toBeDefined();

		act(() => {
			handle!.push({
				event: "observation",
				data: { observation: { observation_id: "obs-42", name: "span-x" } },
			});
		});

		expect(onObservation).toHaveBeenCalledTimes(1);
		expect(onObservation).toHaveBeenCalledWith({
			observation: { observation_id: "obs-42", name: "span-x" },
		});
	});

  it("routes event: status with {status:'complete'} → onStatus('complete')", async () => {
    const { onStatus, result } = setupHook(VALID_TRACE_ID);

		await act(async () => {
			await flushMicrotasks();
		});

		const handle = handleByUrl.get(`/v1/traces/${VALID_TRACE_ID}/events`);
		expect(handle).toBeDefined();

		act(() => {
			handle!.push({ event: "status", data: { status: "complete" } });
		});

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith("complete");
    expect(result.result.current.completed).toBe(true);
    expect(handle!.reconnectCalls).toContainEqual({ pause: true });
  });

	it("invalid traceId (regex miss): no stream opens, onStatus('not_found') fires", async () => {
		const { onStatus, onSnapshot, onObservation } = setupHook(
			"not-a-valid-trace-id",
		);

		// The hook calls useEventSource unconditionally (Rules of Hooks) but
		// with `enabled: false` and a placeholder URL — no SSE fetch should be
		// issued for any URL matching the trace-events pattern.
		const traceUrl = Array.from(handleByUrl.keys()).find((k) =>
			/\/v1\/traces\/[^/]+\/events$/.test(k),
		);
		expect(traceUrl).toBeUndefined();

		// Synthetic not_found fires on a microtask.
		await act(async () => {
			await flushMicrotasks();
			await flushMicrotasks();
		});

		expect(onStatus).toHaveBeenCalledTimes(1);
		expect(onStatus).toHaveBeenCalledWith("not_found");
		expect(onSnapshot).not.toHaveBeenCalled();
		expect(onObservation).not.toHaveBeenCalled();
	});

	it("maps an SSE 404 response to not_found without a REST request", async () => {
		const { onStatus } = setupHook(VALID_TRACE_ID);

		await act(async () => {
			await flushMicrotasks();
		});

		const handle = handleByUrl.get(`/v1/traces/${VALID_TRACE_ID}/events`);
		expect(handle).toBeDefined();

		act(() => {
			handle!.pushError(new EventSourceHttpError(404));
		});

		expect(onStatus).toHaveBeenCalledTimes(1);
		expect(onStatus).toHaveBeenCalledWith("not_found");
		expect(Array.from(handleByUrl.keys())).toEqual([
			`/v1/traces/${VALID_TRACE_ID}/events`,
		]);
	});

	it("pause() / resume() propagate to the underlying hook; paused reflects user state", async () => {
		const { result } = setupHook(VALID_TRACE_ID);

		await act(async () => {
			await flushMicrotasks();
		});

		const handle = handleByUrl.get(`/v1/traces/${VALID_TRACE_ID}/events`);
		expect(handle).toBeDefined();

		// Initially not paused.
		expect(result.result.current.paused).toBe(false);

		act(() => {
			result.result.current.pause();
		});
		expect(handle!.triggerReconnect).toBeDefined();
		expect(result.result.current.paused).toBe(true);

		act(() => {
			result.result.current.resume();
		});
		expect(result.result.current.paused).toBe(false);
	});
});
