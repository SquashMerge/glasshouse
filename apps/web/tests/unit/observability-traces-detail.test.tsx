/**
 * `TraceDetailPage` — live-updating detail view at
 * `/observability/traces/:id`. The component is the canonical consumer of
 * `useTraceStream`; we mock that hook here so the test can drive the
 * snapshot / observation / status callbacks deterministically without
 * actually opening an SSE stream.
 *
 * AC1 — invalid id renders "Trace not found", SSE is not opened.
 * AC6 — Recording → Recorded pill transition on `onStatus("complete")`.
 * AC7 — Pause / Resume; live indicator greys out during pause.
 * AC8 — `?span=<observation_id>` deep-link auto-selects the matching row on
 *      mount (spans-tab row click); verified via the
 *      `data-observation-id`/`data-selected` selectors.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	render,
	screen,
	waitFor,
	act,
	fireEvent,
	cleanup,
	within,
} from "@testing-library/react";
import { TraceDetailPage } from "../../src/routes/observability/traces/$id";
import { ObservationDetailPanel } from "../../src/components/ObservationDetailPanel";
import {
	getTraceDetail,
	type ObservationRow,
	type TraceRow,
} from "../../src/lib/api";

vi.mock("../../src/lib/api", async () => {
	const actual =
		await vi.importActual<typeof import("../../src/lib/api")>(
			"../../src/lib/api",
		);
	return { ...actual, getTraceDetail: vi.fn() };
});

const mockedGetTraceDetail = vi.mocked(getTraceDetail);

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const VALID_ID = "0123456789abcdef0123456789abcdef";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

interface MockTraceStreamHandle {
	callbacks: {
		onSnapshot: (msg: {
			trace?: TraceRow;
			observations: Array<Record<string, unknown>>;
			snapshot_truncated?: boolean;
			next_cursor?: string;
		}) => void;
		onObservation: (msg: { observation: Record<string, unknown> }) => void;
		onStatus: (status: "complete" | "not_found") => void;
	} | null;
	setPaused: (p: boolean) => void;
	setStatus: (s: "connecting" | "open" | "closed") => void;
}

const handleByTraceId = new Map<string, MockTraceStreamHandle>();
const projectIdByTraceId = new Map<string, string | null | undefined>();

vi.mock("../../src/hooks/useTraceStream", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/hooks/useTraceStream")
	>("../../src/hooks/useTraceStream");
	return {
		...actual,
		useTraceStream: (
			traceId: string,
			options: {
				onSnapshot: (msg: {
					trace?: TraceRow;
					observations: Array<Record<string, unknown>>;
				}) => void;
				onObservation: (msg: { observation: Record<string, unknown> }) => void;
				onStatus: (status: "complete" | "not_found") => void;
			},
			projectId?: string | null,
		) => {
			// Mirror the real hook's contract: invalid id → don't emit a handle
			// (the page short-circuits before calling the hook in production).
			// We still render the hook unconditionally for Rules of Hooks, but
			// if the id fails the regex we skip the registration effect.
			const [paused, setPaused] = React.useState(false);
			const [status, setStatus] = React.useState<
				"connecting" | "open" | "closed"
			>("open");

			const handle: MockTraceStreamHandle = {
				callbacks: options,
				setPaused,
				setStatus,
			};
			React.useLayoutEffect(() => {
				if (!/^[0-9a-f]{32}$/.test(traceId)) return;
				handleByTraceId.set(traceId, handle);
				projectIdByTraceId.set(traceId, projectId);
				return () => {
					if (handleByTraceId.get(traceId) === handle)
						handleByTraceId.delete(traceId);
					projectIdByTraceId.delete(traceId);
				};
			}, [projectId, traceId]);

			return {
				get status() {
					return status;
				},
				get paused() {
					return paused;
				},
				get lastEventAt() {
					return Date.now();
				},
				reconnect: (next?: { pause?: boolean }) => {
					if (next?.pause !== undefined) {
						if (next.pause) {
							setPaused(true);
							setStatus("closed");
						} else {
							setPaused(false);
							setStatus("open");
						}
					}
				},
				get debug() {
					return {
						framesReceived: 0,
						bufferDepth: 0,
						reconnectAttempts: 0,
						lastError: null,
					};
				},
				pause: () => {
					setPaused(true);
					setStatus("closed");
				},
				resume: () => {
					setPaused(false);
					setStatus("open");
				},
			};
		},
	};
});

let selectedProjectId: string | null = null;
let selectedProjectRole: "user" | "read_only" = "user";

vi.mock("../../src/components/ProjectProvider", () => ({
	useOptionalProjectSelection: () =>
		selectedProjectId
			? {
					selectedProjectId,
					selectedProject: { project_role: selectedProjectRole },
				}
			: null,
}));

// We mock `@tanstack/react-router` so we can supply our own `useParams` /
// `useLocation` values without standing up a real router instance.
let __params: { id: string } = { id: VALID_ID };
let __location: { searchStr: string } = { searchStr: "" };

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
		"@tanstack/react-router",
	);
	return {
		...actual,
		useParams: <T extends Record<string, string>>(_opts?: {
			from?: string;
		}): T => {
			return __params as unknown as T;
		},
		useLocation: () => __location,
	};
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setRoute(id: string, span?: string): void {
	__params = { id };
	__location = { searchStr: span ? `?span=${span}` : "" };
}

function makeObservation(
	overrides: Partial<{
		observation_id: string;
		parent_observation_id: string | null;
		name: string;
		start_time: string;
		duration_ms: number | null;
		status: "ok" | "error";
		model: string | null;
		input_text: string;
		output_text: string;
		metadata: string;
		input_retained_truncated: boolean;
		output_retained_truncated: boolean;
	}> = {},
): Record<string, unknown> {
	return {
		observation_id: overrides.observation_id ?? "obs-1",
		parent_observation_id: overrides.parent_observation_id ?? null,
		name: overrides.name ?? "root",
		start_time: overrides.start_time ?? "2026-01-01T00:00:00Z",
		duration_ms: overrides.duration_ms ?? 100,
		status: overrides.status ?? "ok",
		model: overrides.model ?? null,
		input_text: overrides.input_text ?? "",
		output_text: overrides.output_text ?? "",
		input_retained_truncated: overrides.input_retained_truncated ?? false,
		output_retained_truncated: overrides.output_retained_truncated ?? false,
		metadata: overrides.metadata ?? "{}",
	};
}

function renderAt(id: string, span?: string): ReturnType<typeof render> {
	setRoute(id, span);
	return render(<TraceDetailPage />);
}

beforeEach(() => {
	handleByTraceId.clear();
	projectIdByTraceId.clear();
	mockedGetTraceDetail.mockReset();
	selectedProjectId = null;
	selectedProjectRole = "user";
	setRoute(VALID_ID);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	setRoute(VALID_ID);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TraceDetailPage — feedback project readiness", () => {
	it("does not accept a comment that project restoration would discard", () => {
		const { rerender } = renderAt(VALID_ID);

		expect(screen.getByLabelText("Comment")).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Thumbs up trace" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Thumbs down trace" }),
		).toBeDisabled();

		selectedProjectId = PROJECT_ID;
		rerender(<TraceDetailPage />);

		expect(screen.getByLabelText("Comment")).toBeEnabled();
		fireEvent.input(screen.getByLabelText("Comment"), {
			target: { value: "Helpful first-pass trace" },
		});
		rerender(<TraceDetailPage />);
		expect(screen.getByLabelText("Comment")).toHaveValue(
			"Helpful first-pass trace",
		);
	});
});

describe("TraceDetailPage — invalid id gate", () => {
	it("renders the 'Trace not found' placeholder for an invalid id and never opens the SSE", async () => {
		renderAt("not-hex");

		await waitFor(() => {
			expect(screen.getByTestId("trace-not-found")).toBeInTheDocument();
		});

		expect(screen.getByText(/Trace not found/i)).toBeInTheDocument();

		// The mock registry should be empty for invalid ids because the page
		// returns before calling `useTraceStream`.
		expect(handleByTraceId.has("not-hex")).toBe(false);
	});
});

describe("TraceDetailPage — ?span= deep-link", () => {
	it("auto-selects the observation whose id matches ?span= once the snapshot arrives", async () => {
		// The spans-tab row click navigates with `?span=<observation_id>`.
		// The trace detail page resolves it to the matching observation via a
		// `React.useEffect` keyed on the search string. This test reproduces
		// that wiring by setting the mocked `useLocation().searchStr` before
		// rendering and then asserting both the detail panel and the span row
		// flip into the selected state.
		const SPAN_TARGET_ID = "e".repeat(32);
		const ROOT_ID = "f".repeat(32);

		renderAt(VALID_ID, SPAN_TARGET_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		await act(async () => {
			handle.callbacks!.onSnapshot({
				observations: [
					// Root observation present — without the deep-link, the page would
					// select this as the default selection on mount.
					makeObservation({ observation_id: ROOT_ID, name: "root" }),
					// Non-root observation that the ?span= should target.
					makeObservation({
						observation_id: SPAN_TARGET_ID,
						parent_observation_id: ROOT_ID,
						name: "deep-link-target",
						input_text: "TARGET_INPUT",
					}),
					// Sibling observation that should NOT be selected.
					makeObservation({
						observation_id: "9".repeat(32),
						parent_observation_id: ROOT_ID,
						name: "not-me",
					}),
				],
			});
		});

		// 1. The detail panel renders the deep-link target (not the root), proving
		//    the `?span=` selector won the default-selection race.
		const detail = await screen.findByTestId("observation-detail");
		expect(detail).toHaveAttribute("data-observation-id", SPAN_TARGET_ID);
		fireEvent.click(screen.getByRole("tab", { name: /Input/i }));
		expect(screen.getByTestId("detail-input")).toHaveTextContent(
			/TARGET_INPUT/,
		);

		// 2. The matching span row carries the deterministic `data-selected`
		//    attribute; the other rows do not. Three snapshot rows ⇒ use the
		//    plural query.
		const rows = await screen.findAllByTestId("span-row");
		expect(rows).toHaveLength(3);
		const matching = rows.find(
			(r) => r.getAttribute("data-observation-id") === SPAN_TARGET_ID,
		);
		expect(matching).toBeDefined();
		expect(matching!).toHaveAttribute("data-selected", "true");

		const rootRow = rows.find(
			(r) => r.getAttribute("data-observation-id") === ROOT_ID,
		);
		expect(rootRow).toBeDefined();
		expect(rootRow!).toHaveAttribute("data-selected", "false");

		const otherRow = rows.find(
			(r) => r.getAttribute("data-observation-id") === "9".repeat(32),
		);
		expect(otherRow).toBeDefined();
		expect(otherRow!).toHaveAttribute("data-selected", "false");
	});
});

describe("TraceDetailPage — snapshot + live observations", () => {
	it("passes the selected project to the trace detail stream", async () => {
		selectedProjectId = PROJECT_ID;
		renderAt(VALID_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		expect(projectIdByTraceId.get(VALID_ID)).toBe(PROJECT_ID);
	});

	it("hides trace and observation feedback controls from read-only project users", async () => {
		selectedProjectId = PROJECT_ID;
		selectedProjectRole = "read_only";
		renderAt(VALID_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		await act(async () => {
			handleByTraceId.get(VALID_ID)!.callbacks!.onSnapshot({
				observations: [makeObservation()],
			});
		});

		expect(screen.queryByLabelText("Thumbs up trace")).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText("Thumbs up Observation"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Add to dataset" }),
		).not.toBeInTheDocument();
	});

	it("clears the prior project's snapshot and observation feedback controls before the new snapshot arrives", async () => {
		selectedProjectId = PROJECT_ID;
		const page = renderAt(VALID_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		await act(async () => {
			handleByTraceId.get(VALID_ID)!.callbacks!.onSnapshot({
				observations: [
					makeObservation({
						observation_id: "a".repeat(32),
						name: "first-project-observation",
					}),
				],
			});
		});
		expect(
			screen.getAllByText("first-project-observation").length,
		).toBeGreaterThan(0);
		expect(screen.getByLabelText("Thumbs up Observation")).toBeInTheDocument();

		selectedProjectId = OTHER_PROJECT_ID;
		page.rerender(<TraceDetailPage />);

		await waitFor(() =>
			expect(projectIdByTraceId.get(VALID_ID)).toBe(OTHER_PROJECT_ID),
		);
		expect(screen.queryAllByText("first-project-observation")).toHaveLength(0);
		expect(
			screen.queryByLabelText("Thumbs up Observation"),
		).not.toBeInTheDocument();
	});

	it("uses the snapshot observations without a REST fallback", async () => {
		renderAt(VALID_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		await act(async () => {
			handle.callbacks!.onSnapshot({
				trace: { trace_id: VALID_ID, name: "trace snapshot name" } as TraceRow,
				observations: [makeObservation({ name: "observation fallback name" })],
			});
		});

		expect(screen.getByTestId("trace-name")).toHaveTextContent(
			"trace snapshot name",
		);
		expect(handleByTraceId.size).toBe(1);
	});

	it("retains a truncated snapshot cursor and offers to load later pages", async () => {
		renderAt(VALID_ID);
		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));

		await act(async () => {
			handleByTraceId.get(VALID_ID)!.callbacks!.onSnapshot({
				observations: [makeObservation({ name: "first-page" })],
				snapshot_truncated: true,
				next_cursor: "later-page",
			});
		});

		expect(
			screen.getByRole("button", { name: "Load remaining observations" }),
		).toBeInTheDocument();
	});

	it("merges a reconnect snapshot with loaded continuations and live rows while refreshing its cursor", async () => {
		selectedProjectId = PROJECT_ID;
		mockedGetTraceDetail.mockResolvedValueOnce({
			trace: { trace_id: VALID_ID, name: "trace" } as TraceRow,
			observations: [
				makeObservation({
					observation_id: "b".repeat(32),
					name: "continuation",
				}) as unknown as ObservationRow,
			],
			next_cursor: "after-continuation",
		});
		renderAt(VALID_ID);
		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		await act(async () => {
			handle.callbacks!.onSnapshot({
				observations: [
					makeObservation({ observation_id: "a".repeat(32), name: "snapshot" }),
				],
				snapshot_truncated: true,
				next_cursor: "first-snapshot-cursor",
			});
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Load remaining observations" }),
		);
		await screen.findByText("continuation");
		await act(async () => {
			handle.callbacks!.onObservation({
				observation: makeObservation({
					observation_id: "c".repeat(32),
					name: "live",
				}),
			});
			handle.callbacks!.onSnapshot({
				observations: [
					makeObservation({ observation_id: "a".repeat(32), name: "snapshot" }),
					makeObservation({
						observation_id: "d".repeat(32),
						name: "reconnect",
					}),
				],
				snapshot_truncated: true,
				next_cursor: "stale-snapshot-cursor",
			});
		});

		const rows = await screen.findAllByTestId("span-row");
		expect(rows).toHaveLength(4);
		expect(screen.getByTestId("span-tree")).toHaveTextContent("continuation");
		expect(screen.getByTestId("span-tree")).toHaveTextContent("live");
		expect(screen.getByTestId("span-tree")).toHaveTextContent("reconnect");
		mockedGetTraceDetail.mockResolvedValueOnce({
			trace: { trace_id: VALID_ID, name: "trace" } as TraceRow,
			observations: [],
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Load remaining observations" }),
		);
		await waitFor(() =>
			expect(mockedGetTraceDetail).toHaveBeenLastCalledWith(VALID_ID, {
				project_id: PROJECT_ID,
				cursor: "stale-snapshot-cursor",
			}),
		);
	});

	it("updates a fully loaded trace to a truncated reconnect snapshot without losing prior rows", async () => {
		selectedProjectId = PROJECT_ID;
		mockedGetTraceDetail.mockResolvedValueOnce({
			trace: { trace_id: VALID_ID, name: "trace" } as TraceRow,
			observations: [
				makeObservation({
					observation_id: "b".repeat(32),
					name: "loaded continuation",
				}) as unknown as ObservationRow,
			],
		});
		renderAt(VALID_ID);
		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		await act(async () => {
			handle.callbacks!.onSnapshot({
				observations: [
					makeObservation({
						observation_id: "a".repeat(32),
						name: "first page",
					}),
				],
				snapshot_truncated: true,
				next_cursor: "initial-cursor",
			});
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Load remaining observations" }),
		);
		await screen.findByText("loaded continuation");
		expect(
			screen.queryByRole("button", { name: "Load remaining observations" }),
		).not.toBeInTheDocument();

		await act(async () => {
			handle.callbacks!.onStatus("complete");
			handle.callbacks!.onSnapshot({
				observations: [
					makeObservation({
						observation_id: "a".repeat(32),
						name: "first page",
					}),
					makeObservation({
						observation_id: "c".repeat(32),
						name: "new reconnect row",
					}),
				],
				snapshot_truncated: true,
				next_cursor: "reconnect-cursor",
			});
		});

		expect(screen.getByTestId("span-tree")).toHaveTextContent(
			"loaded continuation",
		);
		expect(screen.getByTestId("span-tree")).toHaveTextContent(
			"new reconnect row",
		);
		mockedGetTraceDetail.mockResolvedValueOnce({
			trace: { trace_id: VALID_ID, name: "trace" } as TraceRow,
			observations: [],
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Load remaining observations" }),
		);
		await waitFor(() =>
			expect(mockedGetTraceDetail).toHaveBeenLastCalledWith(VALID_ID, {
				project_id: PROJECT_ID,
				cursor: "reconnect-cursor",
			}),
		);
	});

	it("renders the 3 snapshot observation rows in the tree", async () => {
		renderAt(VALID_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		await act(async () => {
			handle.callbacks!.onSnapshot({
				observations: [
					makeObservation({
						observation_id: "a".repeat(32),
						name: "root-span",
					}),
					makeObservation({
						observation_id: "b".repeat(32),
						parent_observation_id: "a".repeat(32),
						name: "child-1",
					}),
					makeObservation({
						observation_id: "c".repeat(32),
						parent_observation_id: "a".repeat(32),
						name: "child-2",
					}),
				],
			});
		});

		const rows = await screen.findAllByTestId("span-row");
		expect(rows).toHaveLength(3);
		expect(screen.getByTestId("trace-header")).toBeInTheDocument();
		expect(screen.getByTestId("trace-workspace")).toBeInTheDocument();
		expect(screen.getByTestId("sse-debug-overlay")).toBeInTheDocument();
		const tree = screen.getByTestId("span-tree");
		expect(tree).toHaveTextContent("root-span");
		expect(tree).toHaveTextContent("child-1");
		expect(tree).toHaveTextContent("child-2");
	});

	it("appends a new observation via onObservation and applies the 1.5s highlight class", async () => {
		renderAt(VALID_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		await act(async () => {
			handle.callbacks!.onSnapshot({
				observations: [
					makeObservation({ observation_id: "a".repeat(32), name: "first" }),
				],
			});
		});
		const tree = screen.getByTestId("span-tree");
		expect(tree).toHaveTextContent("first");

		// New observation arrives via the SSE.
		await act(async () => {
			handle.callbacks!.onObservation({
				observation: makeObservation({
					observation_id: "d".repeat(32),
					name: "new-span",
				}),
			});
		});

		const rows = await screen.findAllByTestId("span-row");
		expect(rows).toHaveLength(2);

		// The new row carries the `bg-accent/40` highlight class — same as the
		// 1.5s pattern used on the list pages.
		const newRow = rows.find(
			(r) => r.getAttribute("data-observation-id") === "d".repeat(32),
		);
		expect(newRow).toBeDefined();
		expect(newRow!.className).toContain("bg-accent/40");
	});

	it("keeps a repeated live observation highlighted until its latest version expires", async () => {
		renderAt(VALID_ID);
		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;
		vi.useFakeTimers();

		await act(async () => {
			handle.callbacks!.onSnapshot({ observations: [makeObservation()] });
			handle.callbacks!.onObservation({
				observation: makeObservation({ name: "first update" }),
			});
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		await act(async () => {
			handle.callbacks!.onObservation({
				observation: makeObservation({ name: "second update" }),
			});
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		const row = screen.getByTestId("span-row");
		expect(row).toHaveAttribute("data-highlighted", "true");
		expect(row).toHaveTextContent("second update");

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(row).toHaveAttribute("data-highlighted", "false");
	});

	it("shows malformed-data diagnostics rather than silently dropping it", async () => {
		renderAt(VALID_ID);
		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		await act(async () => {
			handle.callbacks!.onSnapshot({
				observations: [makeObservation(), { name: "missing id" }],
			});
		});

		expect(screen.getByTestId("trace-diagnostics")).toHaveTextContent(
			"1 malformed observation was ignored",
		);
	});
});

describe("TraceDetailPage — Stream toggle", () => {
	it("preserves a complete stream status as Recorded", async () => {
		renderAt(VALID_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;
		await act(async () => {
			handle.callbacks!.onSnapshot({ observations: [makeObservation()] });
			handle.callbacks!.onStatus("complete");
		});

		expect(screen.getByTestId("trace-recording-status")).toHaveTextContent(
			"Recorded",
		);
	});

	it("starts On/Streaming on a connected snapshot", async () => {
		renderAt(VALID_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		await act(async () => {
			handle.callbacks!.onSnapshot({
				observations: [
					makeObservation({ observation_id: "a".repeat(32), name: "live" }),
				],
			});
		});

		const toggle = await screen.findByTestId("stream-toggle");
		expect(toggle.getAttribute("data-state")).toBe("on-open");
		expect(
			screen.getByTestId("stream-toggle-button").getAttribute("aria-checked"),
		).toBe("true");
		expect(screen.getByTestId("stream-toggle-button").textContent).toMatch(
			/Streaming/,
		);
	});

	it("clicking the toggle flips it to Off/Paused, clicking again restores it", async () => {
		renderAt(VALID_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		await act(async () => {
			handle.callbacks!.onSnapshot({
				observations: [
					makeObservation({
						observation_id: "a".repeat(32),
						name: "before-pause",
					}),
				],
			});
		});

		const button = await screen.findByTestId("stream-toggle-button");

		fireEvent.click(button);
		await waitFor(() =>
			expect(
				screen.getByTestId("stream-toggle").getAttribute("data-state"),
			).toBe("off"),
		);
		expect(button.textContent).toMatch(/Paused/);

		fireEvent.click(button);
		await waitFor(() =>
			expect(
				screen.getByTestId("stream-toggle").getAttribute("data-state"),
			).toBe("on-open"),
		);
		expect(button.textContent).toMatch(/Streaming/);
	});
});

describe("TraceDetailPage — span detail tabs", () => {
	it("clicking a span row renders its input/output/metadata in the detail panel", async () => {
		renderAt(VALID_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		await act(async () => {
			handle.callbacks!.onSnapshot({
				observations: [
					makeObservation({
						observation_id: "a".repeat(32),
						name: "click-me",
						input_text: "INPUT_TEXT_HERE",
						output_text: "OUTPUT_TEXT_HERE",
						metadata: JSON.stringify({
							schema_version: 1,
							attributes: [
								{ key: "tool", value: { stringValue: "x" } },
								{ key: "value", value: { intValue: 42 } },
							],
							prompt_provenance: null,
						}),
					}),
				],
			});
		});

		const row = await screen.findByTestId("span-row");
		fireEvent.click(row);

		// The detail panel reads from the selected workspace observation.
		const detail = await screen.findByTestId("observation-detail");
		expect(detail).toBeInTheDocument();
		fireEvent.click(screen.getByRole("tab", { name: /Input/i }));
		expect(screen.getByTestId("detail-input")).toHaveTextContent(
			/INPUT_TEXT_HERE/,
		);

		// Switch to the Output tab and check the rendered text.
		fireEvent.click(screen.getByRole("tab", { name: /Output/i }));
		expect(screen.getByTestId("detail-output")).toHaveTextContent(
			/OUTPUT_TEXT_HERE/,
		);

		// The metadata tree opens fully expanded in the detail panel.
		fireEvent.click(screen.getByRole("tab", { name: /Metadata/i }));
		const metadataTree = screen.getByTestId("detail-metadata");
		expect(within(metadataTree).getByText('"x"')).toBeInTheDocument();
		expect(
			within(metadataTree).getByRole("button", {
				name: "Collapse all JSON nodes",
			}),
		).toBeInTheDocument();
	});

	it("identifies retained-field truncation without presenting excerpts as full values", async () => {
		render(
			<ObservationDetailPanel
				traceId={VALID_ID}
				observation={{
					...makeObservation({
						input_text: "retained input",
						output_text: "retained output",
						input_retained_truncated: true,
						output_retained_truncated: true,
						metadata: JSON.stringify({
							schema_version: 1,
							attributes: [],
							prompt_provenance: null,
							truncated: true,
						}),
					}),
					observation_id: "obs-retained",
				}}
			/>,
		);

		const truncationState = screen.getByRole("status");
		expect(truncationState).toHaveTextContent("Input retained at 8 KiB");
		expect(truncationState).toHaveTextContent("Output retained at 8 KiB");
		expect(truncationState).toHaveTextContent("Metadata retained at 16 KiB");
	});

	it("persists the keyboard-accessible split and moves the closed inspector trigger into a distinct rail", async () => {
		window.localStorage.setItem("astraea.trace-detail.workspace-width", "44");
		renderAt(VALID_ID);
		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		await act(async () => {
			handle.callbacks!.onSnapshot({ observations: [makeObservation()] });
		});

		const splitter = screen.getByTestId("trace-detail-splitter");
		expect(splitter).toHaveAttribute("role", "separator");
		expect(splitter).toHaveAttribute("aria-valuenow", "44");
		fireEvent.keyDown(splitter, { key: "ArrowRight" });
		expect(splitter).toHaveAttribute("aria-valuenow", "46");
		expect(
			window.localStorage.getItem("astraea.trace-detail.workspace-width"),
		).toBe("46");

		fireEvent.keyDown(screen.getByTestId("observation-detail"), {
			key: "Escape",
		});
		expect(screen.queryByTestId("observation-detail")).not.toBeInTheDocument();
		const inspectorRail = screen.getByRole("complementary", {
			name: "Inspector",
		});
		expect(inspectorRail).toHaveClass("xl:border-l", "xl:bg-muted/20");
		expect(screen.getByTestId("show-inspector")).toBeInTheDocument();
		await waitFor(() =>
			expect(document.activeElement).toHaveAttribute(
				"data-observation-id",
				"obs-1",
			),
		);

		fireEvent.click(screen.getByTestId("show-inspector"));
		expect(screen.getByTestId("observation-detail")).toBeInTheDocument();
		expect(
			screen.queryByRole("complementary", { name: "Inspector" }),
		).not.toBeInTheDocument();
	});
});

describe("TraceDetailPage — not_found synthetic status", () => {
	it("renders the 'Trace not found' placeholder when the server returns onStatus('not_found')", async () => {
		renderAt(VALID_ID);

		await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
		const handle = handleByTraceId.get(VALID_ID)!;

		// Server 404 short-circuit fires.
		await act(async () => {
			handle.callbacks!.onStatus("not_found");
		});

		await waitFor(() => {
			expect(screen.getByTestId("trace-not-found")).toBeInTheDocument();
		});
	});
});
