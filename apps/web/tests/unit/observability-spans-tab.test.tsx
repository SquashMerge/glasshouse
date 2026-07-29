import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	render,
	screen,
	waitFor,
	act,
	fireEvent,
	cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import {
	SpansTab,
	type ObservationEvent,
} from "../../src/routes/observability";
import { emptyObservationMetadata, listObservations } from "../../src/lib/api";

vi.mocked(listObservations);

// --- Mocks -----------------------------------------------------------------

const navigate = vi.fn();
let pushEvent: ((msg: { event: string; data: unknown }) => void) | null = null;
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
let selectedProjectId = PROJECT_ID;
let sseUrl = "";

vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({ selectedProjectId }),
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
	// Default `listObservations` returns a single row matching the default
	// SPAN_ID so SSE pushes with `SPAN_ID` hit the "in-view" path
	// (highlight + render). Tests push other ids via `mockResolvedValueOnce`.
	return {
		...actual,
		listObservations: vi.fn(async () => ({
			items: [
				{
					observation_id: SPAN_ID,
					trace_id: TRACE_ID,
					project_id: PROJECT_ID,
					parent_observation_id: null,
					type: "span",
					name: "first-span",
					start_time: "2026-01-01 00:00:00",
					end_time: "2026-01-01 00:00:01",
					duration_ms: 1000,
					status: "ok",
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
	type ReconnectFn = (opts?: { pause?: boolean }) => void;
	return {
		...actual,
		useEventSource: (
			url: string,
			opts: {
				enabled?: boolean;
				onMessage?: (msg: { event: string; data: unknown }) => void;
			} = {},
		) => {
			sseUrl = url;
			pushEvent = opts.onMessage ?? null;
			let paused = false;
			const reconnect: ReconnectFn = (next) => {
				if (next?.pause !== undefined) paused = next.pause;
			};
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
				reconnect,
			};
		},
	};
});

// --- Helpers ---------------------------------------------------------------

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "fedcba9876543210fedcba9876543210";

function makeSpanEvent(
	overrides: Partial<ObservationEvent> = {},
): ObservationEvent {
	return {
		observation_id: overrides.observation_id ?? SPAN_ID,
		trace_id: overrides.trace_id ?? TRACE_ID,
		project_id: PROJECT_ID,
		parent_observation_id: null,
		type: overrides.type ?? "span",
		name: overrides.name ?? "root",
		start_time: "2026-01-01 00:00:00",
		end_time: "2026-01-01 00:00:01",
		duration_ms: 1000,
		status: "ok",
		model: null,
		input_text: "",
		output_text: "",
		metadataParsed: overrides.metadataParsed ?? null,
		...overrides,
	};
}

function renderWithQueryClient(ui: React.ReactNode) {
	const qc = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0, staleTime: 0 },
		},
	});
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	navigate.mockReset();
	navigate.mockResolvedValue(undefined);
	pushEvent = null;
	selectedProjectId = PROJECT_ID;
	sseUrl = "";
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

// --- Tests -----------------------------------------------------------------

describe("SpansTab — SSE merge + highlight", () => {
	it("highlights an in-view SSE event row", async () => {
		renderWithQueryClient(<SpansTab />);
		// Wait for the paginated row to render (proves paginatedIds is populated).
		await screen.findByText("first-span", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());

		act(() => {
			pushEvent!({
				event: "observation",
				data: {
					observation: makeSpanEvent({ name: "first-span" }),
					metadataParsed: null,
				},
			});
		});

		const cell = await screen.findByText("first-span");
		const row = cell.closest("tr");
		expect(row).not.toBeNull();
		expect(row!.getAttribute("data-highlighted")).toBe("true");
		expect(vi.mocked(listObservations)).toHaveBeenCalledWith(
			expect.objectContaining({ project_id: PROJECT_ID }),
		);
		expect(sseUrl).toBe(`/v1/observations/events?project_id=${PROJECT_ID}`);
	});

	it("uses a fresh SSE scope when the selected project changes", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
		});
		const rendered = render(
			<QueryClientProvider client={client}>
				<SpansTab />
			</QueryClientProvider>,
		);
		await screen.findByText("first-span", {}, { timeout: 2000 });

		selectedProjectId = OTHER_PROJECT_ID;
		rendered.rerender(
			<QueryClientProvider client={client}>
				<SpansTab />
			</QueryClientProvider>,
		);

		await waitFor(() =>
			expect(vi.mocked(listObservations)).toHaveBeenCalledWith(
				expect.objectContaining({ project_id: OTHER_PROJECT_ID }),
			),
		);
		expect(sseUrl).toBe(
			`/v1/observations/events?project_id=${OTHER_PROJECT_ID}`,
		);
	});

	it("navigates to /observability/traces/{32-hex}?span={obs_id} on row click", async () => {
		renderWithQueryClient(<SpansTab />);
		const cell = await screen.findByText("first-span", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());

		act(() => {
			pushEvent!({
				event: "observation",
				data: {
					observation: makeSpanEvent({
						observation_id: SPAN_ID,
						trace_id: TRACE_ID,
						name: "clickable-span",
					}),
					metadataParsed: null,
				},
			});
		});

		const row = cell.closest("tr");
		expect(row).not.toBeNull();
		fireEvent.click(row!);

		await waitFor(() => expect(navigate).toHaveBeenCalled());
		const call = navigate.mock.calls[0]?.[0] as {
			to: string;
			search?: { span?: string };
		};
		expect(call.to).toBe(`/observability/traces/${TRACE_ID}`);
		expect(call.search?.span).toBe(SPAN_ID);
	});

	it("highlights an in-view observation on SSE; cell content stays from paginated", async () => {
		renderWithQueryClient(<SpansTab />);
		await screen.findByText("first-span", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());

		act(() => {
			pushEvent!({
				event: "observation",
				data: {
					observation: makeSpanEvent({
						observation_id: SPAN_ID,
						name: "first-span",
					}),
					metadataParsed: {
						schema_version: 1,
						attributes: [
							{
								key: "tool",
								value: { stringValue: "tool-from-metadata" },
							},
							{
								key: "model",
								value: { stringValue: "gpt-4o-from-metadata" },
							},
						],
						prompt_provenance: null,
					},
				},
			});
		});

		// Paginated values are still what the cells show; the list page does
		// not consume metadataParsed (detail page does via useTraceStream).
		expect(screen.queryByText("tool-from-metadata")).not.toBeInTheDocument();
		expect(screen.queryByText("gpt-4o-from-metadata")).not.toBeInTheDocument();

		const cell = screen.getByText("first-span");
		const row = cell.closest("tr");
		expect(row?.getAttribute("data-highlighted")).toBe("true");
	});

	it("inserts an out-of-view SSE observation sorted by start_time DESC and bumps the total", async () => {
		renderWithQueryClient(<SpansTab />);
		await screen.findByText("first-span", {}, { timeout: 2000 });
		await waitFor(() => expect(pushEvent).not.toBeNull());

		const newerId = "0123456789abcdef0123456789abcdee";
		act(() => {
			pushEvent!({
				event: "observation",
				data: {
					observation: makeSpanEvent({
						observation_id: newerId,
						name: "newer-sse-span",
						start_time: "2026-01-02 00:00:00",
						end_time: "2026-01-02 00:00:01",
					}),
					metadataParsed: null,
				},
			});
		});

		await screen.findByText("newer-sse-span");
		const newerRow = screen.getByText("newer-sse-span").closest("tr");
		const olderRow = screen.getByText("first-span").closest("tr");
		expect(newerRow).not.toBeNull();
		expect(olderRow).not.toBeNull();
		const tbody = newerRow!.parentElement;
		expect(tbody).not.toBeNull();
		const children = Array.from(tbody!.children);
		const newerIdx = children.indexOf(newerRow!);
		const olderIdx = children.indexOf(olderRow!);
		expect(newerIdx).toBeGreaterThanOrEqual(0);
		expect(olderIdx).toBeGreaterThan(newerIdx);

		await screen.findByText("2 of 2 spans");
	});

	it("renders the Stream toggle on the SpansTab header (SSE open, not paused)", async () => {
		renderWithQueryClient(<SpansTab />);
		const toggle = await screen.findByTestId("stream-toggle");
		expect(toggle.getAttribute("data-state")).toBe("on-open");
		const button = screen.getByTestId("stream-toggle-button");
		expect(button.getAttribute("aria-checked")).toBe("true");
		expect(button.textContent).toMatch(/Streaming/);
	});

	it("re-runs the listObservations query when a filter input changes (filters flow to the API)", async () => {
		// Regression: see observability-traces-tab.test.tsx for the same shape.
		const fn = vi.mocked(listObservations);
		fn.mockClear();

		renderWithQueryClient(<SpansTab />);

		await screen.findByText("first-span", {}, { timeout: 2000 });
		await waitFor(() => expect(fn.mock.calls.length).toBeGreaterThanOrEqual(1));
		const initialCalls = fn.mock.calls.length;

		// SPAN_FILTER_FIELDS first non-type filter is `name`, placeholder
		// "e.g. llm.call".
		const nameInput = screen.getByPlaceholderText("e.g. llm.call");
		fireEvent.change(nameInput, { target: { value: "specific-span" } });

		await act(async () => {
			await new Promise((r) => setTimeout(r, 300));
		});

		await waitFor(() =>
			expect(fn.mock.calls.length).toBeGreaterThan(initialCalls),
		);

		const lastCall = fn.mock.calls[fn.mock.calls.length - 1]?.[0] as {
			name?: string;
		};
		expect(lastCall?.name).toBe("specific-span");
	});
});
