// Integration test: SpansTab driving the REAL useEventSource hook (no
// synthetic pushEvent mock). Replaces only authedFetch with a fake stream
// controller, so the full fetch → reader → parser → onMessage → React
// state → merge → total chain runs as in production.
//
// Uses real timers (not fake) because React Query's fetch promises need
// the microtask queue; fake timers would block them. The hook's 100ms
// coalesce window is waited on with real setTimeout, which is fast enough.

import {
	vi,
	describe,
	it,
	expect,
	beforeAll,
	beforeEach,
	afterEach,
} from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { SpansTab } from "../../src/routes/observability";
import { emptyObservationMetadata, listObservations } from "../../src/lib/api";

vi.mocked(listObservations);

const navigate = vi.fn();

vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({ selectedProjectId: "proj-1" }),
}));

// --- Fake stream controller -------------------------------------------------

interface FakeStream {
	stream: ReadableStream<Uint8Array>;
	enqueue(text: string): void;
	close(): void;
	fail(err?: unknown): void;
}

function createFakeStream(): FakeStream {
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
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
				/* already errored */
			}
			controller = null;
		},
	};
}

const fakeStreams: FakeStream[] = [];

// Replace authedFetch — every call gets a fresh fake stream we control.
// The real useEventSource hook is NOT mocked, so the full transport chain runs.
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
				signal.addEventListener("abort", () => {
					try {
						fake.fail(new DOMException("aborted", "AbortError"));
					} catch {
						/* noop */
					}
				});
			}
			return new Response(fake.stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}),
	};
});

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
					observation_id: "a".repeat(32),
					trace_id: "t".repeat(32),
					project_id: "proj-1",
					parent_observation_id: null,
					type: "span" as const,
					name: "initial-row",
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

function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function commentFrame(text: string): string {
	return `:${text}\n\n`;
}

beforeAll(() => {
	// jsdom has no IntersectionObserver; FilterableTable uses it for the load-more sentinel.
	// @ts-expect-error -- globalThis augmentation for jsdom test env
	globalThis.IntersectionObserver = class {
		observe() {}
		disconnect() {}
		unobserve() {}
	};
});

beforeEach(() => {
	fakeStreams.length = 0;
	navigate.mockReset();
	navigate.mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function renderWithQueryClient(ui: React.ReactNode) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
	});
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("SpansTab × real useEventSource — full SSE transport", () => {
	it("SSE frames from the wire reach the spans table and bump the total", async () => {
		renderWithQueryClient(<SpansTab />);

		// Initial REST fetch settles.
		await screen.findByText("initial-row", {}, { timeout: 2000 });

		// authedFetch has been called once for /v1/observations/events.
		await waitFor(() => expect(fakeStreams.length).toBeGreaterThanOrEqual(1));
		const stream = fakeStreams[0]!;

		// Server handshake: `:ok` comment frame first.
		await act(async () => {
			stream.enqueue(commentFrame("ok"));
		});

		// Real observation frame.
		await act(async () => {
			stream.enqueue(
				frame("observation", {
					observation: {
						observation_id: "b".repeat(32),
						trace_id: "t".repeat(32),
						project_id: "proj-1",
						parent_observation_id: null,
						type: "span",
						name: "from-the-wire",
						start_time: "2026-01-02 00:00:00",
						end_time: "2026-01-02 00:00:01",
						duration_ms: 500,
						status: "ok",
						model: null,
						input_text: "",
						output_text: "",
						metadata: "",
					},
					metadataParsed: null,
				}),
			);
		});

		// Wait for the row to appear in the table + counter to advance. The row is
		// sorted by start_time DESC so it lands above the older paginated row.
		await waitFor(
			() => {
				expect(screen.queryByText("from-the-wire")).toBeInTheDocument();
				expect(screen.queryByText("2 of 2 spans")).toBeInTheDocument();
			},
			{ timeout: 3000 },
		);
	});

	it("SseDebugOverlay reflects framesReceived as real SSE frames flow through", async () => {
		renderWithQueryClient(<SpansTab />);
		await screen.findByText("initial-row", {}, { timeout: 2000 });
		await waitFor(() => expect(fakeStreams.length).toBeGreaterThanOrEqual(1));
		const stream = fakeStreams[0]!;

		await act(async () => {
			stream.enqueue(commentFrame("ok"));
		});

		for (let i = 0; i < 3; i++) {
			await act(async () => {
				stream.enqueue(
					frame("observation", {
						observation: {
							observation_id: `c${String(i).padStart(31, "0")}`,
							trace_id: "t".repeat(32),
							project_id: "proj-1",
							parent_observation_id: null,
							type: "span",
							name: `wired-${i}`,
							start_time: `2026-01-02 00:00:0${i}`,
							end_time: `2026-01-02 00:00:0${i + 1}`,
							duration_ms: 100,
							status: "ok",
							model: null,
							input_text: "",
							output_text: "",
							metadata: "",
						},
						metadataParsed: null,
					}),
				);
			});
		}

		await waitFor(
			() => {
				expect(screen.getByTestId("sse-debug-framesReceived").textContent).toBe(
					"3",
				);
			},
			{ timeout: 3000 },
		);
	});

	it("connection drop on the SSE stream does not break the table; auto-reconnect fires a new authedFetch", async () => {
		renderWithQueryClient(<SpansTab />);
		await screen.findByText("initial-row", {}, { timeout: 2000 });
		await waitFor(() => expect(fakeStreams.length).toBeGreaterThanOrEqual(1));
		const firstStream = fakeStreams[0]!;

		await act(async () => {
			firstStream.fail(new Error("server reset"));
		});

		// First reconnect attempt backoff is 1s — wait past it.
		await waitFor(
			() => {
				expect(fakeStreams.length).toBeGreaterThanOrEqual(2);
			},
			{ timeout: 3000 },
		);

		// Existing data still rendered, no error state.
		expect(screen.queryByText("initial-row")).toBeInTheDocument();
	});
});
