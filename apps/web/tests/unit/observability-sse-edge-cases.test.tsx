// Edge-case tests for the table-page SSE merge + total counter.
//
// Covers scenarios the existing observability-{traces,spans}-tab.test.tsx
// files don't exercise:
//   - Mixed new + update SSE events land in the same batch
//   - 200+ new SSE ids hit the FIFO cap, total stays correct
//   - SseDebugOverlay renders and reflects framesReceived for spans tab
//   - Filter changes re-run the query and the total reflects the new total

import {
	describe,
	it,
	expect,
	vi,
	beforeAll,
	beforeEach,
	afterEach,
} from "vitest";
import {
	render,
	screen,
	waitFor,
	act,
	cleanup,
	fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import {
	TracesTab,
	SpansTab,
	type TraceEvent,
	type ObservationEvent,
} from "../../src/routes/observability";
import {
	emptyObservationMetadata,
	listTraces,
	listObservations,
} from "../../src/lib/api";

vi.mocked(listTraces);
vi.mocked(listObservations);

const navigate = vi.fn();
let pushEvent: ((msg: { event: string; data: unknown }) => void) | null = null;
let framesReceived = 0;

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
		"@tanstack/react-router",
	);
	return {
		...actual,
		useNavigate: () => navigate,
		useLocation: () => ({ searchStr: "" }),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual =
		await vi.importActual<typeof import("../../src/lib/api")>(
			"../../src/lib/api",
		);
	return {
		...actual,
		listTraces: vi.fn(async () => ({ items: [], total: 0 })),
		listObservations: vi.fn(async () => ({ items: [], total: 0 })),
	};
});

vi.mock("../../src/hooks/useEventSource", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/hooks/useEventSource")
	>("../../src/hooks/useEventSource");
	return {
		...actual,
		useEventSource: (
			_url: string,
			opts: {
				enabled?: boolean;
				onMessage?: (msg: { event: string; data: unknown }) => void;
			} = {},
		) => {
			pushEvent = opts.onMessage ?? null;
			let paused = false;
			return {
				get status(): "connecting" | "open" | "closed" {
					return opts.enabled === false ? "closed" : "open";
				},
				get paused(): boolean {
					return paused;
				},
				get lastEventAt(): number | null {
					return paused ? null : Date.now();
				},
				get debug() {
					return {
						framesReceived,
						bufferDepth: 0,
						reconnectAttempts: 0,
						lastError: null,
					};
				},
				reconnect: (next?: { pause?: boolean }) => {
					if (next?.pause !== undefined) paused = next.pause;
				},
			};
		},
	};
});

// IntersectionObserver isn't defined in jsdom by default; the FilterableTable
// uses it for the "load more" sentinel. Stub a no-op so the effect doesn't throw.
beforeAll(() => {
	// @ts-expect-error -- globalThis augmentation for jsdom test env
	globalThis.IntersectionObserver = class {
		observe() {}
		disconnect() {}
		unobserve() {}
	};
});

function makeTraceEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
	return {
		trace_id: overrides.trace_id ?? "0".repeat(32),
		project_id: "proj-1",
		name: overrides.name ?? "sse-new",
		start_time: overrides.start_time ?? "2026-01-02 00:00:00",
		end_time: "2026-01-02 00:00:01",
		duration_ms: 1000,
		status: "ok",
		user_id: "u1",
		session_id: "s1",
		agent_id: "agent-1",
		agent_version: "v1",
		env: "dev",
		tags: [],
		input_text: "",
		output_text: "",
		scores_summary: "",
	};
}

function makeSpanEvent(
	overrides: Partial<ObservationEvent> = {},
): ObservationEvent {
	return {
		observation_id: overrides.observation_id ?? "0".repeat(32),
		trace_id: overrides.trace_id ?? "0".repeat(32),
		project_id: "proj-1",
		parent_observation_id: null,
		type: overrides.type ?? "span",
		name: overrides.name ?? "sse-new",
		start_time: overrides.start_time ?? "2026-01-02 00:00:00",
		end_time: overrides.end_time ?? "2026-01-02 00:00:01",
		duration_ms: 1000,
		status: overrides.status ?? "ok",
		model: null,
		input_text: "",
		output_text: "",
		metadataParsed: null,
		...overrides,
	};
}

function renderWithQueryClient(ui: React.ReactNode) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
	});
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	navigate.mockReset();
	navigate.mockResolvedValue(undefined);
	pushEvent = null;
	framesReceived = 0;
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// --- Mixed new + update SSE events -----------------------------------------

describe("TracesTab — mixed new + update SSE batches", () => {
	it("a batch with 2 new + 1 update-for-existing yields total = `10 of 12 traces`", async () => {
		vi.mocked(listTraces).mockResolvedValue({
			items: Array.from({ length: 10 }, (_, i) => ({
				trace_id: `t${String(i).padStart(31, "0")}`,
				project_id: "proj-1",
				name: `paginated-${i}`,
				start_time: `2026-01-01 00:00:${String(i).padStart(2, "0")}`,
				end_time: `2026-01-01 00:00:${String(i + 1).padStart(2, "0")}`,
				duration_ms: 1000,
				status: "ok" as const,
				user_id: "u1",
				session_id: "s1",
				agent_id: "agent-1",
				agent_version: "v1",
				env: "dev",
				tags: [],
				input_text: "",
				output_text: "",
				scores_summary: "",
			})),
			total: 10,
		});

		renderWithQueryClient(<TracesTab />);
		await screen.findByText("paginated-0", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());
		await screen.findByText("10 of 10 traces");

		act(() => {
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "n".repeat(32),
						name: "new-1",
						start_time: "2026-01-02 00:00:01",
					}),
				},
			});
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "m".repeat(32),
						name: "new-2",
						start_time: "2026-01-02 00:00:02",
					}),
				},
			});
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "t" + "0".repeat(30) + "3",
						name: "paginated-3",
						start_time: "2026-01-01 00:00:03",
					}),
				},
			});
		});

		// 2 out-of-view SSE ids → extraStreamedCount = 2; the in-view one
		// (paginated-3) only flags for highlight, not counter. Merged list
		// includes both paginated + 2 SSE rows = 12.
		await screen.findByText("12 of 12 traces", {}, { timeout: 2000 });
	});
});

// --- Many SSE new ids at high rate (capped visible list) -------------------

describe("SpansTab — high-rate out-of-view SSE events", () => {
	it("counter advances linearly; the visible SSE list is FIFO-capped", async () => {
		vi.mocked(listObservations).mockResolvedValue({
			items: Array.from({ length: 10 }, (_, i) => ({
				observation_id: `s${String(i).padStart(31, "0")}`,
				trace_id: `t${String(i).padStart(31, "0")}`,
				project_id: "proj-1",
				parent_observation_id: null,
				type: "span" as const,
				name: `paginated-${i}`,
				start_time: `2026-01-01 00:00:${String(i).padStart(2, "0")}`,
				end_time: `2026-01-01 00:00:${String(i + 1).padStart(2, "0")}`,
				duration_ms: 1000,
				status: "ok" as const,
				model: null,
				input_text: "",
				output_text: "",
				metadata: emptyObservationMetadata(),
			})),
			total: 10,
		});

		renderWithQueryClient(<SpansTab />);
		await screen.findByText("paginated-0", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());
		await screen.findByText("10 of 10 spans");

		// Fire 250 out-of-view SSE events. Counter → 10 + 250 = 260. The visible
		// SSE list stays capped at VISIBLE_SSE_CAP (30).
		act(() => {
			for (let i = 0; i < 250; i++) {
				pushEvent!({
					event: "observation",
					data: {
						observation: makeSpanEvent({
							observation_id: `f${String(i).padStart(31, "0")}`,
							name: `fifo-${i}`,
							start_time: `2026-01-02 00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
						}),
						metadataParsed: null,
					},
				});
			}
		});

		await screen.findByText("40 of 260 spans", {}, { timeout: 10000 });
		// Oldest SSE id was evicted from the visible list; newest is still there.
		expect(screen.queryByText("fifo-0")).not.toBeInTheDocument();
		expect(screen.queryByText("fifo-249")).toBeInTheDocument();
	});
});

// --- SseDebugOverlay state on the Spans tab --------------------------------

describe("SpansTab — SseDebugOverlay integration", () => {
	it("renders the spans debug overlay with framesReceived=0 by default", async () => {
		vi.mocked(listObservations).mockResolvedValue({
			items: Array.from({ length: 3 }, (_, i) => ({
				observation_id: `s${String(i).padStart(31, "0")}`,
				trace_id: `t${String(i).padStart(31, "0")}`,
				project_id: "proj-1",
				parent_observation_id: null,
				type: "span" as const,
				name: `paginated-${i}`,
				start_time: `2026-01-01 00:00:0${i}`,
				end_time: `2026-01-01 00:00:0${i + 1}`,
				duration_ms: 1000,
				status: "ok" as const,
				model: null,
				input_text: "",
				output_text: "",
				metadata: emptyObservationMetadata(),
			})),
			total: 3,
		});

		renderWithQueryClient(<SpansTab />);
		await screen.findByText("paginated-0", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());

		const overlay = await screen.findByTestId("sse-debug-overlay");
		expect(overlay).toBeInTheDocument();
		expect(screen.getByTestId("sse-debug-label").textContent).toMatch(/spans/);
		expect(screen.getByTestId("sse-debug-status").textContent).toBe("open");
		expect(screen.getByTestId("sse-debug-framesReceived").textContent).toBe(
			"0",
		);
		expect(screen.getByTestId("sse-debug-lastError").textContent).toBe("—");
	});

	it("reflects an incrementing framesReceived counter as SSE events arrive", async () => {
		vi.mocked(listObservations).mockResolvedValue({
			items: Array.from({ length: 3 }, (_, i) => ({
				observation_id: `s${String(i).padStart(31, "0")}`,
				trace_id: `t${String(i).padStart(31, "0")}`,
				project_id: "proj-1",
				parent_observation_id: null,
				type: "span" as const,
				name: `paginated-${i}`,
				start_time: `2026-01-01 00:00:0${i}`,
				end_time: `2026-01-01 00:00:0${i + 1}`,
				duration_ms: 1000,
				status: "ok" as const,
				model: null,
				input_text: "",
				output_text: "",
				metadata: emptyObservationMetadata(),
			})),
			total: 3,
		});

		renderWithQueryClient(<SpansTab />);
		await screen.findByText("paginated-0", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());

		for (let i = 0; i < 5; i++) {
			framesReceived = i + 1;
			act(() => {
				pushEvent!({
					event: "observation",
					data: {
						observation: makeSpanEvent({
							observation_id: `c${String(i).padStart(31, "0")}`,
							name: `counted-${i}`,
							start_time: `2026-01-02 00:00:0${i}`,
						}),
						metadataParsed: null,
					},
				});
			});
		}

		await waitFor(() => {
			expect(screen.getByTestId("sse-debug-framesReceived").textContent).toBe(
				"5",
			);
		});
	});
});

// --- Filter change while SSE rows are present ------------------------------

describe("TracesTab — filter change while SSE rows are present", () => {
	it("typing a filter re-runs listTraces and total reflects the new paginatedTotal", async () => {
		vi.mocked(listTraces).mockResolvedValueOnce({
			items: Array.from({ length: 10 }, (_, i) => ({
				trace_id: `t${String(i).padStart(31, "0")}`,
				project_id: "proj-1",
				name: `paginated-${i}`,
				start_time: `2026-01-01 00:00:${String(i).padStart(2, "0")}`,
				end_time: `2026-01-01 00:00:${String(i + 1).padStart(2, "0")}`,
				duration_ms: 1000,
				status: "ok" as const,
				user_id: "u1",
				session_id: "s1",
				agent_id: "agent-1",
				agent_version: "v1",
				env: "dev",
				tags: [],
				input_text: "",
				output_text: "",
				scores_summary: "",
			})),
			total: 10,
		});

		renderWithQueryClient(<TracesTab />);
		await screen.findByText("paginated-0", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());
		await screen.findByText("10 of 10 traces");

		act(() => {
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "z".repeat(32),
						name: "old-live-row",
					}),
				},
			});
		});
		await screen.findByText("11 of 11 traces");

		vi.mocked(listTraces).mockResolvedValueOnce({
			items: [],
			total: 0,
		});

		const nameInput = screen.getByPlaceholderText(
			"e.g. llm.call or tool.search_db",
		);
		fireEvent.change(nameInput, { target: { value: "needle" } });

		await act(async () => {
			await new Promise((r) => setTimeout(r, 300));
		});

		await waitFor(() =>
			expect(screen.queryByText("0 of 0 traces")).toBeInTheDocument(),
		);
		expect(screen.queryByText("old-live-row")).not.toBeInTheDocument();

		act(() => {
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "x".repeat(32),
						name: "does-not-match",
					}),
				},
			});
		});
		expect(screen.queryByText("does-not-match")).not.toBeInTheDocument();
		expect(screen.getByText("0 of 0 traces")).toBeInTheDocument();

		act(() => {
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "y".repeat(32),
						name: "needle match",
					}),
				},
			});
		});
		await screen.findByText("1 of 1 trace");
		expect(screen.getByText("needle match")).toBeInTheDocument();
	});
});
