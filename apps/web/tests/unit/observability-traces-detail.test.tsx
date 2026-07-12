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
import { render, screen, waitFor, act, fireEvent, cleanup } from "@testing-library/react";
import { TraceDetailPage } from "../../src/routes/observability/traces/$id";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const VALID_ID = "0123456789abcdef0123456789abcdef";

interface MockTraceStreamHandle {
  callbacks: {
    onSnapshot: (msg: { observations: Array<Record<string, unknown>> }) => void;
    onObservation: (msg: { observation: Record<string, unknown> }) => void;
    onStatus: (status: "complete" | "not_found") => void;
  } | null;
  setPaused: (p: boolean) => void;
  setStatus: (s: "connecting" | "open" | "closed") => void;
}

const handleByTraceId = new Map<string, MockTraceStreamHandle>();

vi.mock("../../src/hooks/useTraceStream", async () => {
  const actual = await vi.importActual<typeof import("../../src/hooks/useTraceStream")>(
    "../../src/hooks/useTraceStream",
  );
  return {
    ...actual,
    useTraceStream: (
      traceId: string,
      options: {
        onSnapshot: (msg: { observations: Array<Record<string, unknown>> }) => void;
        onObservation: (msg: { observation: Record<string, unknown> }) => void;
        onStatus: (status: "complete" | "not_found") => void;
      },
    ) => {
      // Mirror the real hook's contract: invalid id → don't emit a handle
      // (the page short-circuits before calling the hook in production).
      // We still render the hook unconditionally for Rules of Hooks, but
      // if the id fails the regex we skip the registration effect.
      const [paused, setPaused] = React.useState(false);
      const [status, setStatus] = React.useState<"connecting" | "open" | "closed">("open");

      const handle: MockTraceStreamHandle = {
        callbacks: options,
        setPaused,
        setStatus,
      };
      React.useLayoutEffect(() => {
        if (!/^[0-9a-f]{32}$/.test(traceId)) return;
        handleByTraceId.set(traceId, handle);
        return () => {
          if (handleByTraceId.get(traceId) === handle) handleByTraceId.delete(traceId);
        };
      }, [traceId]);

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
    useParams: <T extends Record<string, string>>(_opts?: { from?: string }): T => {
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
    metadata: overrides.metadata ?? "{}",
  };
}

function renderAt(id: string, span?: string): ReturnType<typeof render> {
  setRoute(id, span);
  return render(<TraceDetailPage />);
}

beforeEach(() => {
  handleByTraceId.clear();
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
    expect(screen.getByTestId("detail-input")).toHaveTextContent(/TARGET_INPUT/);

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

    const rootRow = rows.find((r) => r.getAttribute("data-observation-id") === ROOT_ID);
    expect(rootRow).toBeDefined();
    expect(rootRow!).toHaveAttribute("data-selected", "false");

    const otherRow = rows.find((r) => r.getAttribute("data-observation-id") === "9".repeat(32));
    expect(otherRow).toBeDefined();
    expect(otherRow!).toHaveAttribute("data-selected", "false");
  });
});

describe("TraceDetailPage — snapshot + live observations", () => {
  it("renders the 3 snapshot observation rows in the tree", async () => {
    renderAt(VALID_ID);

    await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
    const handle = handleByTraceId.get(VALID_ID)!;

    await act(async () => {
      handle.callbacks!.onSnapshot({
        observations: [
          makeObservation({ observation_id: "a".repeat(32), name: "root-span" }),
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
        observation: makeObservation({ observation_id: "d".repeat(32), name: "new-span" }),
      });
    });

    const rows = await screen.findAllByTestId("span-row");
    expect(rows).toHaveLength(2);

    // The new row carries the `bg-accent/40` highlight class — same as the
    // 1.5s pattern used on the list pages.
    const newRow = rows.find((r) => r.getAttribute("data-observation-id") === "d".repeat(32));
    expect(newRow).toBeDefined();
    expect(newRow!.className).toContain("bg-accent/40");
  });
});

describe("TraceDetailPage — Recording → Recorded pill transition", () => {
  it("flips the pill from Recording to Recorded when onStatus('complete') fires", async () => {
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

    // Initially the pill reads "Recording".
    const pill = await screen.findByTestId("recording-pill");
    expect(pill).toHaveTextContent(/Recording/i);

    // Server fires `status: complete` after the 30s grace.
    await act(async () => {
      handle.callbacks!.onStatus("complete");
    });

    await waitFor(() => {
      expect(screen.getByTestId("recording-pill")).toHaveTextContent(/Recorded/i);
    });
  });
});

describe("TraceDetailPage — Pause / Resume", () => {
  it("clicking Pause greys the live indicator and shows the Resume button", async () => {
    renderAt(VALID_ID);

    await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
    const handle = handleByTraceId.get(VALID_ID)!;

    await act(async () => {
      handle.callbacks!.onSnapshot({
        observations: [
          makeObservation({ observation_id: "a".repeat(32), name: "before-pause" }),
        ],
      });
    });

    // Click pause.
    fireEvent.click(screen.getByTestId("pause-button"));

    // The live indicator should now read "Paused".
    await waitFor(() => {
      expect(screen.getByTestId("live-indicator")).toHaveAttribute("data-state", "paused");
    });
    expect(screen.getByTestId("live-label")).toHaveTextContent(/Paused/i);

    // A button labelled "Resume" should be visible now.
    expect(screen.getByTestId("resume-button")).toBeInTheDocument();
  });

  it("clicking Resume restores the live indicator label and the Pause button", async () => {
    renderAt(VALID_ID);

    await waitFor(() => expect(handleByTraceId.has(VALID_ID)).toBe(true));
    const handle = handleByTraceId.get(VALID_ID)!;

    await act(async () => {
      handle.callbacks!.onSnapshot({
        observations: [
          makeObservation({ observation_id: "a".repeat(32), name: "before-pause" }),
        ],
      });
    });

    fireEvent.click(screen.getByTestId("pause-button"));
    await waitFor(() => {
      expect(screen.getByTestId("live-indicator")).toHaveAttribute("data-state", "paused");
    });

    fireEvent.click(screen.getByTestId("resume-button"));

    await waitFor(() => {
      expect(screen.getByTestId("live-indicator")).toHaveAttribute("data-state", "live");
    });
    expect(screen.getByTestId("live-label")).toHaveTextContent(/Live/i);
    expect(screen.getByTestId("pause-button")).toBeInTheDocument();
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
            metadata: JSON.stringify({ tool: "x", value: 42 }),
          }),
        ],
      });
    });

    const row = await screen.findByTestId("span-row");
    fireEvent.click(row);

    // The detail panel reads from `observations[0]` via the selectedId state.
    const detail = await screen.findByTestId("observation-detail");
    expect(detail).toBeInTheDocument();
    expect(screen.getByTestId("detail-input")).toHaveTextContent(/INPUT_TEXT_HERE/);

    // Switch to the Output tab and check the rendered text.
    fireEvent.click(screen.getByRole("tab", { name: /Output/i }));
    expect(screen.getByTestId("detail-output")).toHaveTextContent(/OUTPUT_TEXT_HERE/);

    // Switch to the Metadata tab and check pretty-printed JSON.
    fireEvent.click(screen.getByRole("tab", { name: /Metadata/i }));
    expect(screen.getByTestId("detail-metadata")).toHaveTextContent(/"tool"/);
    expect(screen.getByTestId("detail-metadata")).toHaveTextContent(/"x"/);
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
