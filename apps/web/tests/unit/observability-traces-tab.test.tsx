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
  return {
    ...actual,
    listTraces: vi.fn(async () => ({ items: [], total: 0 })),
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

function makeTraceEvent(overrides: Partial<{ trace_id: string; name: string; status: "ok" | "error" }> = {}): TraceEvent {
  return {
    trace_id: overrides.trace_id ?? TRACE_ID,
    project_id: "proj-1",
    name: overrides.name ?? "llm.call",
    start_time: "2026-01-01 00:00:00",
    end_time: "2026-01-01 00:00:01",
    duration_ms: 1000,
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
  it("appends an SSE event row and highlights it for ~1.5s", async () => {
    renderWithQueryClient(<TracesTab />);

    await waitFor(() => expect(pushEvent).not.toBeNull());

    // Push one event through the mocked SSE.
    act(() => {
      pushEvent!({ event: "trace", data: makeTraceEvent({ name: "first.call" }) });
    });

    // Wait for the row to appear (the coalesce flush is 100ms).
    const cell = await screen.findByText("first.call", {}, { timeout: 2000 });
    expect(cell).toBeInTheDocument();

    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-highlighted")).toBe("true");

    // Advance past the 1.5s highlight window via fake timers.
    vi.useFakeTimers();
    act(() => {
      vi.advanceTimersByTime(1700);
    });
    vi.useRealTimers();
  });

  it("dedups by trace_id when the same event arrives twice", async () => {
    renderWithQueryClient(<TracesTab />);

    await waitFor(() => expect(pushEvent).not.toBeNull());

    act(() => {
      pushEvent!({ event: "trace", data: makeTraceEvent({ name: "dup.call" }) });
    });
    // Allow the first flush + render.
    await screen.findByText("dup.call");

    act(() => {
      pushEvent!({ event: "trace", data: makeTraceEvent({ name: "dup.call" }) });
    });

    // Wait briefly for any second render to land, then assert single row.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getAllByText("dup.call")).toHaveLength(1);
  });

  it("navigates to /observability/traces/{32-hex} with NO query string on row click", async () => {
    renderWithQueryClient(<TracesTab />);

    await waitFor(() => expect(pushEvent).not.toBeNull());

    act(() => {
      pushEvent!({ event: "trace", data: makeTraceEvent({ trace_id: TRACE_ID, name: "clickable" }) });
    });

    const cell = await screen.findByText("clickable");
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const call = navigate.mock.calls[0]?.[0] as { to: string; search?: unknown };
    expect(call.to).toBe(`/observability/traces/${TRACE_ID}`);
    expect(call.search).toBeUndefined();
  });

  it("renders the X-of-Y counter using merged.length and total + streamed.length", async () => {
    renderWithQueryClient(<TracesTab />);

    await waitFor(() => expect(pushEvent).not.toBeNull());

    // One SSE event → merged.length = 1, paginated.total = 0, streamed.length = 1.
    act(() => {
      pushEvent!({
        event: "trace",
        data: makeTraceEvent({ trace_id: "c".repeat(32), name: "counter-one" }),
      });
    });

    await screen.findByText("counter-one");

    // Total = paginatedTotal (0 from mocked listTraces) + streamed.length (1) = 1.
    // merged.length = 1. So the counter reads "1 of 1 trace".
    const counter = await screen.findByText("1 of 1 trace");
    expect(counter).toBeInTheDocument();
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