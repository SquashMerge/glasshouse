// Tests for the "X of Y" total counter + visible SSE merge on the Traces tab.
//
// After this iteration: out-of-view SSE rows ARE inserted into the visible
// list (FIFO-capped at VISIBLE_SSE_CAP=30), sorted by start_time DESC.
// The counter advances for every out-of-view SSE id regardless of cap.

import {
	describe,
	it,
	expect,
	vi,
	beforeAll,
	beforeEach,
	afterEach,
} from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { TracesTab, type TraceEvent } from "../../src/routes/observability";
import { listTraces } from "../../src/lib/api";

vi.mocked(listTraces);

const navigate = vi.fn();
let pushEvent: ((msg: { event: string; data: unknown }) => void) | null = null;

vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({ selectedProjectId: "proj-1" }),
}));

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
		listTraces: vi.fn(async () => ({
			items: [
				{
					trace_id: "t0000000000000000000000000000a",
					project_id: "proj-1",
					name: "first.call",
					start_time: "2026-01-01 00:00:00",
					end_time: "2026-01-01 00:00:01",
					duration_ms: 1000,
					status: "ok" as const,
					user_id: "u1",
					session_id: "s1",
					agent_id: "agent-1",
					agent_version: "v1",
					env: "dev",
					tags: [],
					input_text: "hello",
					output_text: "world",
					scores_summary: "",
				},
			],
			total: 1,
		})),
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
						framesReceived: 0,
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

function makeTraceEvent(
	overrides: Partial<Pick<TraceEvent, "trace_id" | "name" | "start_time">> = {},
): TraceEvent {
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

beforeAll(() => {
	// @ts-expect-error -- globalThis augmentation for jsdom test env
	globalThis.IntersectionObserver = class {
		observe() {}
		disconnect() {}
		unobserve() {}
	};
});

function renderWithQueryClient(ui: React.ReactNode) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
	});
	return {
		...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>),
		queryClient: qc,
	};
}

beforeEach(() => {
	navigate.mockReset();
	pushEvent = null;
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("TracesTab — total counter + visible SSE merge", () => {
	it("bumps counter and inserts out-of-view SSE rows sorted by start_time DESC", async () => {
		renderWithQueryClient(<TracesTab />);
		await screen.findByText("first.call", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());
		await screen.findByText("1 of 1 trace");

		// Push 3 out-of-view SSE events with DIFFERENT start_times; the row
		// with the most recent start_time should render at the top of the table.
		act(() => {
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "a".repeat(32),
						name: "middle",
						start_time: "2026-01-02 12:00:00",
					}),
				},
			});
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "b".repeat(32),
						name: "newest",
						start_time: "2026-01-03 00:00:00",
					}),
				},
			});
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "c".repeat(32),
						name: "oldest",
						start_time: "2026-01-02 06:00:00",
					}),
				},
			});
		});

		// Counter bumps for all 3 out-of-view events. Merged = 1 paginated + 3 SSE.
		await screen.findByText("4 of 4 traces", {}, { timeout: 2000 });

		// All 3 SSE rows render in the table.
		expect(screen.queryByText("newest")).toBeInTheDocument();
		expect(screen.queryByText("middle")).toBeInTheDocument();
		expect(screen.queryByText("oldest")).toBeInTheDocument();

		// Sort order: newest > middle > oldest > first.call.
		const tbody = screen.getByText("newest").closest("tr")!.parentElement!;
		const children = Array.from(tbody.children);
		const idx = (name: string) =>
			children.findIndex((row) => row.textContent?.includes(name));
		expect(idx("newest")).toBeLessThan(idx("middle"));
		expect(idx("middle")).toBeLessThan(idx("oldest"));
		expect(idx("oldest")).toBeLessThan(idx("first.call"));
	});

	it("does not bump the counter on an in-view SSE event (highlight only, no row reorder)", async () => {
		renderWithQueryClient(<TracesTab />);
		await screen.findByText("first.call", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());
		await screen.findByText("1 of 1 trace");

		act(() => {
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "t0000000000000000000000000000a",
						name: "first.call",
						start_time: "2026-01-01 00:00:00",
					}),
				},
			});
		});

		await waitFor(() => {
			expect(screen.queryByText("1 of 2 traces")).not.toBeInTheDocument();
		});
		await screen.findByText("1 of 1 trace");

		const cell = screen.getByText("first.call");
		const row = cell.closest("tr");
		expect(row?.getAttribute("data-highlighted")).toBe("true");
	});

	it("deduplicates repeated SSE frames and lets the newest payload win", async () => {
		renderWithQueryClient(<TracesTab />);
		await screen.findByText("first.call", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());

		const id = "d".repeat(32);
		act(() => {
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({ trace_id: id, name: "first payload" }),
				},
			});
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({ trace_id: id, name: "latest payload" }),
				},
			});
		});

		await screen.findByText("2 of 2 traces");
		expect(screen.queryByText("first payload")).not.toBeInTheDocument();
		expect(screen.getAllByText("latest payload")).toHaveLength(1);
	});

	it("reconciles the total when REST later includes a streamed row", async () => {
		const { queryClient } = renderWithQueryClient(<TracesTab />);
		await screen.findByText("first.call", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());

		const streamed = makeTraceEvent({
			trace_id: "e".repeat(32),
			name: "absorbed",
		});
		act(() => pushEvent!({ event: "trace", data: { trace: streamed } }));
		await screen.findByText("2 of 2 traces");

		vi.mocked(listTraces).mockResolvedValueOnce({
			items: [
				{
					trace_id: "t0000000000000000000000000000a",
					project_id: "proj-1",
					name: "first.call",
					start_time: "2026-01-01 00:00:00",
					end_time: "2026-01-01 00:00:01",
					duration_ms: 1000,
					status: "ok",
					user_id: "u1",
					session_id: "s1",
					agent_id: "agent-1",
					agent_version: "v1",
					env: "dev",
					tags: [],
					input_text: "hello",
					output_text: "world",
					scores_summary: "",
				},
				{
					...streamed,
					project_id: "proj-1",
					end_time: streamed.end_time ?? null,
					duration_ms: streamed.duration_ms ?? null,
					user_id: streamed.user_id ?? "",
					session_id: streamed.session_id ?? "",
					agent_id: streamed.agent_id ?? "",
					agent_version: streamed.agent_version ?? "",
					env: streamed.env ?? "",
					tags: streamed.tags ?? [],
					input_text: streamed.input_text ?? "",
					output_text: streamed.output_text ?? "",
					scores_summary: streamed.scores_summary ?? "",
				},
			],
			total: 2,
		});
		await act(async () =>
			queryClient.invalidateQueries({ queryKey: ["traces"] }),
		);

		await screen.findByText("2 of 2 traces");
		expect(screen.getAllByText("absorbed")).toHaveLength(1);
	});

	it("uses trace_id DESC as the deterministic tie-breaker", async () => {
		renderWithQueryClient(<TracesTab />);
		await screen.findByText("first.call", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());

		act(() => {
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "a".repeat(32),
						name: "tie-a",
						start_time: "2026-01-03 00:00:00",
					}),
				},
			});
			pushEvent!({
				event: "trace",
				data: {
					trace: makeTraceEvent({
						trace_id: "b".repeat(32),
						name: "tie-b",
						start_time: "2026-01-03 00:00:00",
					}),
				},
			});
		});

		const rowB = await screen.findByText("tie-b");
		const tbody = rowB.closest("tr")!.parentElement!;
		const rows = Array.from(tbody.children);
		expect(rows.indexOf(rowB.closest("tr")!)).toBeLessThan(
			rows.indexOf(screen.getByText("tie-a").closest("tr")!),
		);
	});

	it("evicts oldest SSE row when FIFO cap is hit; counter still advances", async () => {
		// 1 paginated + 31 SSE ids (cap=30) → oldest SSE id evicted from the
		// visible list but counter still reflects all 31 out-of-view events.
		// Merged = 1 paginated + 30 visible SSE = 31.
		renderWithQueryClient(<TracesTab />);
		await screen.findByText("first.call", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());
		await screen.findByText("1 of 1 trace");

		act(() => {
			for (let i = 0; i < 31; i++) {
				pushEvent!({
					event: "trace",
					data: {
						trace: makeTraceEvent({
							trace_id: `sse${String(i).padStart(29, "0")}`,
							name: `sse-${i}`,
							start_time: `2026-01-02 ${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`,
						}),
					},
				});
			}
		});

		// 1 paginated + 31 out-of-view SSE ids → total = 32. Merged = 1 + 30 (capped) = 31.
		await screen.findByText("31 of 32 traces", {}, { timeout: 10000 });
		// Oldest SSE id (sse-0) was evicted from the visible list.
		expect(screen.queryByText("sse-0")).not.toBeInTheDocument();
		// Newer ones are still there.
		expect(screen.queryByText("sse-30")).toBeInTheDocument();
		expect(screen.queryByText("sse-29")).toBeInTheDocument();
	});
});
