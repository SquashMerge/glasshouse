// Tests for the "X of Y" total counter + visible SSE merge on the Spans tab.
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
import {
	SpansTab,
	type ObservationEvent,
} from "../../src/routes/observability";
import { emptyObservationMetadata, listObservations } from "../../src/lib/api";

vi.mocked(listObservations);

const navigate = vi.fn();
let pushEvent: ((msg: { event: string; data: unknown }) => void) | null = null;

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
		listObservations: vi.fn(async () => ({
			items: [
				{
					observation_id: "f".repeat(32),
					trace_id: "t".repeat(32),
					project_id: "proj-1",
					parent_observation_id: null,
					type: "span" as const,
					name: "first-span",
					start_time: "2026-01-01 00:00:00",
					end_time: "2026-01-01 00:00:01",
					duration_ms: 1000,
					status: "ok" as const,
					model: null,
					input_text: "",
					output_text: "",
					metadata: emptyObservationMetadata(),
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
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
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

describe("SpansTab — total counter + visible SSE merge", () => {
	it("bumps counter and inserts out-of-view SSE rows sorted by start_time DESC", async () => {
		renderWithQueryClient(<SpansTab />);
		await screen.findByText("first-span", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());
		await screen.findByText("1 of 1 span");

		act(() => {
			pushEvent!({
				event: "observation",
				data: {
					observation: makeSpanEvent({
						observation_id: "a".repeat(32),
						name: "middle",
						start_time: "2026-01-02 12:00:00",
					}),
					metadataParsed: null,
				},
			});
			pushEvent!({
				event: "observation",
				data: {
					observation: makeSpanEvent({
						observation_id: "b".repeat(32),
						name: "newest",
						start_time: "2026-01-03 00:00:00",
					}),
					metadataParsed: null,
				},
			});
			pushEvent!({
				event: "observation",
				data: {
					observation: makeSpanEvent({
						observation_id: "c".repeat(32),
						name: "oldest",
						start_time: "2026-01-02 06:00:00",
					}),
					metadataParsed: null,
				},
			});
		});

		await screen.findByText("4 of 4 spans", {}, { timeout: 2000 });

		expect(screen.queryByText("newest")).toBeInTheDocument();
		expect(screen.queryByText("middle")).toBeInTheDocument();
		expect(screen.queryByText("oldest")).toBeInTheDocument();

		const tbody = screen.getByText("newest").closest("tr")!.parentElement!;
		const children = Array.from(tbody.children);
		const idx = (name: string) =>
			children.findIndex((row) => row.textContent?.includes(name));
		expect(idx("newest")).toBeLessThan(idx("middle"));
		expect(idx("middle")).toBeLessThan(idx("oldest"));
		expect(idx("oldest")).toBeLessThan(idx("first-span"));
	});
});
