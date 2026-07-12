import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { TracesTab } from "../../src/routes/observability";
import type { TraceEvent } from "../../src/routes/observability";

// --- Mocks -----------------------------------------------------------------
//
// We mock `@tanstack/react-router`, the API client, and `useEventSource`
// directly. The component under test (`TracesTab`) only uses `useNavigate`
// from the router package, so we don't need a full router instance.

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
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  // Default `listTraces` returns a single row matching the default TRACE_ID
  // so SSE pushes with `TRACE_ID` hit the "in-view" path (highlight + render).
  // Tests that push events with a different id can `mockResolvedValueOnce`
  // to override. Tests that exercise the out-of-view path use the default
  // empty list (mock the response to return `[]`).
  return {
    ...actual,
    listTraces: vi.fn(async () => ({
      items: [
        {
          trace_id: TRACE_ID,
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
      ],
      total: 1,
    })),
  };
});

vi.mock("../../src/hooks/useEventSource", async () => {
  const actual = await vi.importActual<typeof import("../../src/hooks/useEventSource")>(
    "../../src/hooks/useEventSource",
  );
  type ReconnectFn = (opts?: { pause?: boolean }) => void;
  // Shared, persistent state across renders. `paused` and `forcedStatus` are
  // mutated by `reconnect` and by the `setSse*` helper functions; the
  // triggering of a re-render after a mutation is the host component's job
  // (in the real hook, `setPaused(true)` does it; in the mock, the test
  // exercises `data-state` synchronously without re-rendering because the
  // mutation is observable through the same closure that the LiveTabHeader
  // reads via `useEventSource()`).
  let paused = false;
  let forcedStatus: "open" | "closed" | null = null;
  const setSsePaused = (next: boolean) => {
    paused = next;
  };
  const setSseStatus = (next: "open" | "closed" | null) => {
    forcedStatus = next;
  };
  // Expose the mutators via the test scope.
  Object.assign(globalThis as Record<string, unknown>, { __setSsePaused: setSsePaused, __setSseStatus: setSseStatus });

  const reconnect: ReconnectFn = (next) => {
    if (next?.pause !== undefined) paused = next.pause;
  };

  let _lastCallUrl = "";
  return {
    ...actual,
    useEventSource: (
      url: string,
      opts: {
        enabled?: boolean;
        onMessage?: (msg: { event: string; data: unknown }) => void;
      } = {},
    ) => {
      pushEvent = opts.onMessage ?? null;
      _lastCallUrl = url;
      return {
        get status(): "connecting" | "open" | "closed" {
          if (forcedStatus) return forcedStatus;
          return opts.enabled === false ? "closed" : "open";
        },
        get paused(): boolean {
          return paused;
        },
        get lastEventAt(): number | null {
          return paused ? null : Date.now();
        },
        reconnect,
      };
    },
    __getSseUrl: () => _lastCallUrl,
  };
});

// --- Helpers ---------------------------------------------------------------

const TRACE_ID = "0123456789abcdef0123456789abcdef";

function makeTraceEvent(
  overrides: Partial<Pick<TraceEvent, "trace_id" | "name" | "status" | "start_time" | "end_time" | "duration_ms">> = {},
): TraceEvent {
  return {
    trace_id: overrides.trace_id ?? TRACE_ID,
    project_id: "proj-1",
    name: overrides.name ?? "llm.call",
    start_time: overrides.start_time ?? "2026-01-01 00:00:00",
    end_time: overrides.end_time ?? "2026-01-01 00:00:01",
    duration_ms: overrides.duration_ms ?? 1000,
    status: overrides.status ?? "ok",
    user_id: "u1",
    session_id: "s1",
    agent_id: "agent-1",
    agent_version: "v1",
    env: "dev",
    tags: [],
    input_text: "hello",
    output_text: "world",
    scores_summary: "",
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// --- Tests -----------------------------------------------------------------

describe("TracesTab — SSE merge + highlight", () => {
  it("highlights an in-view SSE event row", async () => {
    renderWithQueryClient(<TracesTab />);

    // Wait for the paginated row to render — proves `paginatedIds` is
    // populated before the SSE handler runs (otherwise the row goes through
    // the out-of-view path and never gets highlighted).
    await screen.findByText("first.call", {}, { timeout: 2000 });

    await waitFor(() => expect(pushEvent).not.toBeNull());

    // Wire format: `data: JSON.stringify({ trace: <TraceRow> })`.
    // The default makeTraceEvent() uses TRACE_ID, which matches paginatedIds.
    act(() => {
      pushEvent!({ event: "trace", data: { trace: makeTraceEvent({ name: "first.call" }) } });
    });

    const cell = await screen.findByText("first.call");
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-highlighted")).toBe("true");
  });

  it("does not double-count when the same SSE event arrives twice (highlight Set dedup)", async () => {
    renderWithQueryClient(<TracesTab />);
    await screen.findByText("first.call", {}, { timeout: 2000 });
    await waitFor(() => expect(pushEvent).not.toBeNull());

    // Push the same in-view event twice → Set-based highlight dedup keeps
    // `highlightedKeys` a single entry per id, and the rendered row appears
    // exactly once (paginated is untouched by SSE).
    act(() => {
      pushEvent!({ event: "trace", data: { trace: makeTraceEvent({ name: "first.call" }) } });
    });
    act(() => {
      pushEvent!({ event: "trace", data: { trace: makeTraceEvent({ name: "first.call" }) } });
    });

    const cell = await screen.findByText("first.call");
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-highlighted")).toBe("true");
  });

  it("navigates to /observability/traces/{32-hex} with NO query string on row click", async () => {
    renderWithQueryClient(<TracesTab />);
    // The mock returns a single row with trace_id = TRACE_ID and name = "first.call".
    // Wait for it to render (proves paginatedIds is populated).
    const cell = await screen.findByText("first.call", {}, { timeout: 2000 });
    await waitFor(() => expect(pushEvent).not.toBeNull());

    // Drive an SSE event for the same trace_id → highlights the row in place.
    act(() => {
      pushEvent!({ event: "trace", data: { trace: makeTraceEvent({ name: "clickable" }) } });
    });
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const call = navigate.mock.calls[0]?.[0] as { to: string; search?: unknown };
    expect(call.to).toBe(`/observability/traces/${TRACE_ID}`);
    expect(call.search).toBeUndefined();
  });

  it("inserts an out-of-view SSE row at the top of the list (newest first) and bumps the total", async () => {
    // Map-based merge + sort by start_time DESC: an SSE-arriving trace with a
    // newer start_time than the existing paginated row renders at index 0
    // and contributes to the X-of-Y total.
    renderWithQueryClient(<TracesTab />);
    await screen.findByText("first.call", {}, { timeout: 2000 });

    await waitFor(() => expect(pushEvent).not.toBeNull());

    const newerStart = "2026-01-02 00:00:00";
    act(() => {
      pushEvent!({
        event: "trace",
        data: {
          trace: makeTraceEvent({
            trace_id: "c".repeat(32),
            name: "newer-sse-call",
            start_time: newerStart,
          }),
        },
      });
    });

    await screen.findByText("newer-sse-call");
    // The newer SSE row appears in front of the older paginated row.
    // Compare row positions in the table body.
    const newerRow = screen.getByText("newer-sse-call").closest("tr");
    const olderRow = screen.getByText("first.call").closest("tr");
    expect(newerRow).not.toBeNull();
    expect(olderRow).not.toBeNull();
    const tbody = newerRow!.parentElement;
    expect(tbody).not.toBeNull();
    const children = Array.from(tbody!.children);
    const newerIdx = children.indexOf(newerRow!);
    const olderIdx = children.indexOf(olderRow!);
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThan(newerIdx);

    // No duplicate keys — only one row per id, deduped by the Map merge.
    expect(screen.getAllByText("newer-sse-call").length).toBe(1);

    // Counter: paginatedTotal (1) + SSE ids not in paginated (1) = 2.
    // Merged length is 2 because both rows are unique.
    await screen.findByText("2 of 2 traces");

    // Highlight applied to the new row.
    const cell = screen.getByText("newer-sse-call");
    const row = cell.closest("tr");
    expect(row?.getAttribute("data-highlighted")).toBe("true");
  });

  it("renders a Live pill + Pause button on the TracesTab header (SSE open, not paused)", async () => {
    renderWithQueryClient(<TracesTab />);
    const header = await screen.findByTestId("live-tab-header");
    expect(header.getAttribute("data-state")).toBe("live");

    const pill = screen.getByTestId("live-pill");
    expect(pill.textContent).toBe("Live");

    const pause = screen.getByTestId("live-pause-button");
    expect(pause).toBeInTheDocument();
  });

  it("renders a Reconnecting pill when the SSE status is closed (mock) and not paused", async () => {
    const setStatus = (globalThis as { __setSseStatus?: (s: "closed") => void }).__setSseStatus;
    setStatus?.("closed");
    try {
      renderWithQueryClient(<TracesTab />);
      const header = await screen.findByTestId("live-tab-header");
      expect(header.getAttribute("data-state")).toBe("reconnecting");
      expect(screen.getByTestId("live-pill").textContent).toBe("Reconnecting");
    } finally {
      setStatus?.(null as unknown as "closed");
    }
  });
});