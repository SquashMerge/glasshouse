/**
 * `useEventSource` — fetch-based SSE hook with auth header injection.
 *
 * Verifies (AC3):
 *  - Connects on mount and parses SSE frames (event + data) correctly.
 *  - Skips the `:ok` comment frame emitted by `streamSSE` on connect.
 *  - Reconnects with exponential backoff (1s → 30s cap) after stream errors.
 *  - Coalesces incoming messages via RAF + 100ms time-guard so a burst only
 *    schedules one flush per ~100ms.
 *  - Closes the stream after >60s of continuous visibility-hidden state and
 *    reconnects on the next `visible` event.
 *  - Distinguishes user-pause (`paused: true`, no reconnects) from network
 *    error (`paused: false`, auto-reconnect in background).
 *  - Aborts the in-flight fetch on unmount and skips subsequent reconnects.
 *  - Honors `enabled: false` (no fetch, status closed).
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { EventSourceHttpError, useEventSource } from "../../src/hooks/useEventSource";

// ---------------------------------------------------------------------------
// Fake stream controller — provides a real ReadableStream<Uint8Array> we can
// push chunks to from tests. Each stream exposes a `setReadable(false)` to
// make pending reads reject with a `TypeError` (simulates connection drop).
// ---------------------------------------------------------------------------

interface FakeStream {
	stream: ReadableStream<Uint8Array>;
	enqueue(text: string): void;
	close(): void;
	/** Mark the stream as errored; pending `read()` calls reject with `err`. */
	fail(err?: unknown): void;
	/** True after the consumer called `abort()` on the signal. */
	aborted: boolean;
}

function createFakeStream(): FakeStream {
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let aborted = false;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		stream,
		enqueue(text) {
			if (!controller) return;
			controller.enqueue(new TextEncoder().encode(text));
		},
		close() {
			if (!controller) return;
			controller.close();
			controller = null;
		},
		fail(err: unknown = new Error("connection reset")) {
			if (!controller) return;
			try {
				controller.error(err);
			} catch {
				// already errored
			}
			controller = null;
		},
		get aborted() {
			return aborted;
		},
		set aborted(v: boolean) {
			aborted = v;
		},
	};
}

// ---------------------------------------------------------------------------
// Module mocks — replace authedFetch with a controllable fake. The rest of
// the auth module is kept intact.
// ---------------------------------------------------------------------------

const fakeStreams: FakeStream[] = [];

vi.mock("../../src/lib/auth", async () => {
	const actual =
		await vi.importActual<typeof import("../../src/lib/auth")>(
			"../../src/lib/auth",
		);
	return {
		...actual,
		authedFetch: vi.fn(async (_url: string, init?: RequestInit) => {
			const fake = createFakeStream();
			fakeStreams.push(fake);
			const signal = init?.signal as AbortSignal | undefined;
			if (signal) {
				if (signal.aborted) {
					// Already aborted — return a stream that errors immediately.
					return new Response(
						new ReadableStream<Uint8Array>({
							start(c) {
								queueMicrotask(() =>
									c.error(new DOMException("aborted", "AbortError")),
								);
							},
						}),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					);
				}
				signal.addEventListener("abort", () => {
					fake.aborted = true;
					fake.fail(new DOMException("aborted", "AbortError"));
				});
			}
			return new Response(fake.stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}),
	};
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function commentFrame(text: string): string {
	return `:${text}\n\n`;
}

/** Resolve once macrotasks (timers + IO) and microtasks have drained. */
async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Resolve once microtasks have drained (Promise continuations). */
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

interface RenderHandle<T> {
	readonly result: T;
	readonly unmount: () => void;
	readonly rerender: (props?: unknown) => void;
}

function setupHook<T>(
	options: Omit<Parameters<typeof useEventSource<T>>[1], "onMessage"> & {
		onMessage?: (msg: { event: string; data: unknown }) => void;
	},
): {
	messages: Array<{ event: string; data: unknown }>;
	renderCount: { count: number };
	hook: RenderHandle<ReturnType<typeof useEventSource<T>>>;
} {
	const messages: Array<{ event: string; data: unknown }> = [];
	const renderCount = { count: 0 };
	const wrapper = renderHook(
		() => {
			renderCount.count += 1;
			return useEventSource<T>("/v1/test/events", {
				enabled: true,
				...options,
				onMessage: (msg) => {
					messages.push(msg);
					options.onMessage?.(msg);
				},
			});
		},
		{ initialProps: {} },
	);
	const handle: RenderHandle<ReturnType<typeof useEventSource<T>>> = {
		get result() {
			return wrapper.result.current as ReturnType<typeof useEventSource<T>>;
		},
		unmount: () => wrapper.unmount(),
		rerender: () => wrapper.rerender(),
	};
	return { messages, renderCount, hook: handle };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	fakeStreams.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	// Reset visibilityState / hidden to defaults so tests don't leak.
	try {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "visible",
		});
		Object.defineProperty(document, "hidden", {
			configurable: true,
			get: () => false,
		});
	} catch {
		// ignore
	}
});

describe("useEventSource — SSE transport", () => {
	it("reports a 404 as a terminal transport error without retrying", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"Date",
				"performance",
			],
		});
		const errors: unknown[] = [];
		const authedFetchMock = (await import("../../src/lib/auth"))
			.authedFetch as unknown as ReturnType<typeof vi.fn>;
		authedFetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 }),
		);

		const { hook } = setupHook({ onError: (error) => errors.push(error) });

		await act(async () => {
			await settle();
		});

		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(EventSourceHttpError);
		expect((errors[0] as EventSourceHttpError).status).toBe(404);
		expect(hook.result.status).toBe("closed");

		await act(async () => {
			vi.advanceTimersByTime(60_000);
			await flushMicrotasks();
		});

		expect(authedFetchMock).toHaveBeenCalledTimes(1);
		hook.unmount();
	});

	it("rejects an SSE frame larger than 1 MiB", async () => {
		const errors: Error[] = [];
		const { hook } = setupHook({
			onError: (error) => errors.push(error as Error),
		});
		await act(async () => {
			await settle();
			fakeStreams[0]!.enqueue(
				`event: oversized\ndata: ${"x".repeat(1024 * 1024)}`,
			);
			await settle();
		});

		expect(
			errors.some((error) => error.message === "SSE frame exceeds 1 MiB"),
		).toBe(true);
		hook.unmount();
	});

	it("connects on mount; calls onMessage for each parsed frame", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"Date",
				"performance",
			],
		});

		const { messages, hook } = setupHook<{ id: string }>({});

		// Connect runs in useEffect → authedFetch resolves → reader.read() blocks.
		await act(async () => {
			await settle();
		});

		expect(fakeStreams).toHaveLength(1);
		const stream = fakeStreams[0]!;

		// Emit three frames in one chunk.
		await act(async () => {
			stream.enqueue(frame("trace", { id: "t1" }));
			stream.enqueue(frame("observation", { id: "o1" }));
			stream.enqueue(frame("trace", { id: "t2" }));
			await flushMicrotasks();
		});

		// Flush via RAF + 100ms guard.
		await act(async () => {
			vi.advanceTimersByTime(150);
			await flushMicrotasks();
		});

		expect(messages).toEqual([
			{ event: "trace", data: { id: "t1" } },
			{ event: "observation", data: { id: "o1" } },
			{ event: "trace", data: { id: "t2" } },
		]);
		expect(hook.result.status).toBe("open");
	});

	it("skips the :ok comment frame (no onMessage call)", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"Date",
				"performance",
			],
		});

		const { messages } = setupHook<{ id: string }>({});

		await act(async () => {
			await settle();
		});

		const stream = fakeStreams[0]!;

		await act(async () => {
			// Hono streamSSE writes `:ok\n\n` first to flush headers.
			stream.enqueue(commentFrame("ok"));
			stream.enqueue(frame("trace", { id: "after-ok" }));
			await flushMicrotasks();
		});

		await act(async () => {
			vi.advanceTimersByTime(150);
			await flushMicrotasks();
		});

		expect(messages).toEqual([{ event: "trace", data: { id: "after-ok" } }]);
	});

	it("reconnects with exponential backoff on stream error (1s, 2s, 4s, …, 30s cap)", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"Date",
				"performance",
			],
		});

		setupHook<unknown>({});

		// Initial connect.
		await act(async () => {
			await settle();
		});

		const authedFetchMock = (await import("../../src/lib/auth"))
			.authedFetch as unknown as ReturnType<typeof vi.fn>;
		const callCountBefore = authedFetchMock.mock.calls.length;

		// Helper: error the most-recent stream, wait for catch + reconnect attempt.
		const errorAndAdvance = async (ms: number): Promise<void> => {
			const idx = fakeStreams.length - 1;
			// Error the current stream → reader.read() rejects in a microtask.
			await act(async () => {
				fakeStreams[idx]!.fail();
				// Wait for the catch block to run + scheduleReconnect to set the timer.
				await flushMicrotasks();
			});
			// Advance the fake clock past the backoff window.
			await act(async () => {
				vi.advanceTimersByTime(ms);
				await flushMicrotasks();
			});
		};

		await errorAndAdvance(1_100);
		expect(authedFetchMock.mock.calls.length).toBe(callCountBefore + 1);

		await errorAndAdvance(2_100);
		expect(authedFetchMock.mock.calls.length).toBe(callCountBefore + 2);

		await errorAndAdvance(4_100);
		expect(authedFetchMock.mock.calls.length).toBe(callCountBefore + 3);

		// Verify cap: many consecutive failures should still produce reconnects
		// bounded by 30s — we don't expect a stuck state.
		for (let i = 0; i < 3; i += 1) {
			await errorAndAdvance(31_000);
		}
		expect(authedFetchMock.mock.calls.length).toBe(callCountBefore + 6);
	});

	it("RAF coalescing: 5 synchronous events → 1 flush within 100ms", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"Date",
				"performance",
			],
		});

		const { messages, renderCount } = setupHook<{ i: number }>({});

		await act(async () => {
			await settle();
		});

		const stream = fakeStreams[0]!;
		const rendersBefore = renderCount.count;

		// Push 5 frames synchronously in one chunk.
		await act(async () => {
			let chunk = "";
			for (let i = 0; i < 5; i += 1) chunk += frame("trace", { i });
			stream.enqueue(chunk);
			await flushMicrotasks();
		});

		// Nothing delivered yet — still inside the coalesce window from mount.
		expect(messages).toHaveLength(0);

		// Advance past the 100ms coalesce window → RAF fires → buffer drains.
		await act(async () => {
			vi.advanceTimersByTime(150);
			await flushMicrotasks();
		});

		expect(messages).toHaveLength(5);
		expect(messages.map((m) => m.data)).toEqual([
			{ i: 0 },
			{ i: 1 },
			{ i: 2 },
			{ i: 3 },
			{ i: 4 },
		]);

		// The hook should not have re-rendered 5 separate times for 5 frames —
		// bounded coalescing. Allow some headroom for status transitions
		// ("connecting" → "open") + the single lastEventAt update on flush.
		expect(renderCount.count - rendersBefore).toBeLessThanOrEqual(4);
	});

	it("does not re-render once per frame when frames arrive in separate chunks", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"Date",
				"performance",
			],
		});

		const { messages, renderCount } = setupHook<{ i: number }>({});
		await act(async () => {
			await settle();
		});
		const rendersBefore = renderCount.count;

		for (let i = 0; i < 5; i += 1) {
			await act(async () => {
				fakeStreams[0]!.enqueue(frame("observation", { i }));
				await flushMicrotasks();
			});
		}

		expect(messages).toHaveLength(0);
		expect(renderCount.count).toBe(rendersBefore);

		await act(async () => {
			vi.advanceTimersByTime(150);
			await flushMicrotasks();
		});
		expect(messages).toHaveLength(5);
		expect(renderCount.count - rendersBefore).toBeLessThanOrEqual(2);
	});

	it("visibility-aware: closes after >60s hidden, reconnects on visible", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"Date",
				"performance",
			],
		});

		const { hook } = setupHook<unknown>({});

		await act(async () => {
			await settle();
		});

		expect(hook.result.status).toBe("open");

		const authedFetchMock = (await import("../../src/lib/auth"))
			.authedFetch as unknown as ReturnType<typeof vi.fn>;
		const callsBefore = authedFetchMock.mock.calls.length;

		// Simulate tab going hidden. Override both `visibilityState` AND `hidden`
		// (jsdom doesn't auto-derive them in a way our hook can rely on).
		await act(async () => {
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				get: () => "hidden",
			});
			Object.defineProperty(document, "hidden", {
				configurable: true,
				get: () => true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
			await flushMicrotasks();
		});

		// Advance past the 60s threshold.
		await act(async () => {
			vi.advanceTimersByTime(61_000);
			await flushMicrotasks();
		});

		expect(hook.result.status).toBe("closed");
		// No reconnect while hidden (auto-hidden-close waits for `visible`).
		expect(authedFetchMock.mock.calls.length).toBe(callsBefore);

		// Tab becomes visible again → reconnect.
		await act(async () => {
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				get: () => "visible",
			});
			Object.defineProperty(document, "hidden", {
				configurable: true,
				get: () => false,
			});
			document.dispatchEvent(new Event("visibilitychange"));
			await flushMicrotasks();
			await flushMicrotasks();
		});

		expect(authedFetchMock.mock.calls.length).toBe(callsBefore + 1);
		expect(hook.result.status).toBe("open");
	});

	it("paused flag distinguishes user-pause from network error", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"Date",
				"performance",
			],
		});

		const { hook } = setupHook<unknown>({});

		await act(async () => {
			await settle();
		});

		const authedFetchMock = (await import("../../src/lib/auth"))
			.authedFetch as unknown as ReturnType<typeof vi.fn>;
		const callsBefore = authedFetchMock.mock.calls.length;

		// User pauses: no further reconnects.
		act(() => {
			hook.result.reconnect({ pause: true });
		});
		expect(hook.result.paused).toBe(true);
		expect(hook.result.status).toBe("closed");

		await act(async () => {
			vi.advanceTimersByTime(60_000);
			await flushMicrotasks();
		});
		expect(authedFetchMock.mock.calls.length).toBe(callsBefore);

		// Resume → reconnect happens immediately.
		act(() => {
			hook.result.reconnect({ pause: false });
		});
		expect(hook.result.paused).toBe(false);

		await act(async () => {
			await settle();
		});
		expect(authedFetchMock.mock.calls.length).toBe(callsBefore + 1);
	});

	it("cleanup on unmount: abort signal triggers, no further reconnects", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"Date",
				"performance",
			],
		});

		const { hook } = setupHook<unknown>({});

		await act(async () => {
			await settle();
		});

		expect(fakeStreams).toHaveLength(1);
		const stream = fakeStreams[0]!;
		expect(stream.aborted).toBe(false);

		const authedFetchMock = (await import("../../src/lib/auth"))
			.authedFetch as unknown as ReturnType<typeof vi.fn>;
		const callsBefore = authedFetchMock.mock.calls.length;

		await act(async () => {
			hook.unmount();
			await flushMicrotasks();
		});

		expect(stream.aborted).toBe(true);

		// Advance enough time to trigger any pending reconnect; should not fire.
		await act(async () => {
			vi.advanceTimersByTime(60_000);
			await flushMicrotasks();
		});
		expect(authedFetchMock.mock.calls.length).toBe(callsBefore);
	});

	it("enabled: false does not open the stream", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"Date",
				"performance",
			],
		});

		const { hook } = setupHook<unknown>({ enabled: false });

		await act(async () => {
			await settle();
		});

		expect(hook.result.status).toBe("closed");
		expect(fakeStreams).toHaveLength(0);
	});
});
