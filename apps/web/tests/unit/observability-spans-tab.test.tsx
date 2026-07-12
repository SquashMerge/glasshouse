import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { SpansTab, type ObservationEvent } from "../../src/routes/observability";

// --- Mocks -----------------------------------------------------------------

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
          project_id: "proj-1",
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
          metadata: "",
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
        reconnect,
      };
    },
  };
});

// --- Helpers ---------------------------------------------------------------

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "fedcba9876543210fedcba9876543210";

function makeSpanEvent(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    observation_id: overrides.observation_id ?? SPAN_ID,
    trace_id: overrides.trace_id ?? TRACE_ID,
    project_id: "proj-1",
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
        data: { observation: makeSpanEvent({ name: "first-span" }), metadataParsed: null },
      });
    });

    const cell = await screen.findByText("first-span");
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-highlighted")).toBe("true");
  });

  it("navigates to /observability/traces/{32-hex}?span={obs_id} on row click", async () => {
    renderWithQueryClient(<SpansTab />);
    const cell = await screen.findByText("first-span", {}, { timeout: 2000 });
    await waitFor(() => expect(pushEvent).not.toBeNull());

    act(() => {
      pushEvent!({
        event: "observation",
        data: {
          observation: makeSpanEvent({ observation_id: SPAN_ID, trace_id: TRACE_ID, name: "clickable-span" }),
          metadataParsed: null,
        },
      });
    });

    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const call = navigate.mock.calls[0]?.[0] as { to: string; search?: { span?: string } };
    expect(call.to).toBe(`/observability/traces/${TRACE_ID}`);
    expect(call.search?.span).toBe(SPAN_ID);
  });

  it("uses metadataParsed to populate tool/model/type cells when SSE arrives for in-view observation", async () => {
    // Map-based merge: SSE rows are last-write-wins over paginated rows for
    // the same observation_id, so metadataParsed-derived name/type/model
    // propagate into the cells without a REST refetch.
    renderWithQueryClient(<SpansTab />);
    await screen.findByText("first-span", {}, { timeout: 2000 });
    await waitFor(() => expect(pushEvent).not.toBeNull());

    act(() => {
      pushEvent!({
        event: "observation",
        data: {
          observation: makeSpanEvent({ observation_id: SPAN_ID, name: "first-span" }),
          metadataParsed: {
            tool: { name: "tool-from-metadata" },
            model: "gpt-4o-from-metadata",
            type: "tool",
          },
        },
      });
    });

    // Name column reads metadataParsed.tool.name first.
    await screen.findByText("tool-from-metadata");
    expect(screen.queryByText("first-span")).not.toBeInTheDocument();
    // Model column reads metadataParsed.model.
    expect(screen.getByText("gpt-4o-from-metadata")).toBeInTheDocument();
    // Type badge reflects metadataParsed.type = "tool".
    expect(screen.getAllByText("tool").length).toBeGreaterThanOrEqual(1);

    // Same key — only one row renders, no React duplicate-key warning.
    const cell = screen.getByText("tool-from-metadata");
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-highlighted")).toBe("true");
  });

  it("inserts an out-of-view SSE row at the top of the list (newest first) without duplicates", async () => {
    // Newer observation (later start_time) arrives via SSE for an id that
    // is NOT in the paginated page. mergeByIdDesc sorts by start_time DESC,
    // so it appears at index 0.
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
    // Newer SSE row is above the older paginated row in render order.
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

    // Total bumps by 1 — paginatedTotal (1) + 1 new SSE id.
    await screen.findByText("2 of 2 spans");

    // Highlight applied to the new row.
    const cell = screen.getByText("newer-sse-span");
    const row = cell.closest("tr");
    expect(row?.getAttribute("data-highlighted")).toBe("true");
  });

  it("renders a Live pill + Pause button on the SpansTab header", async () => {
    renderWithQueryClient(<SpansTab />);
    const header = await screen.findByTestId("live-tab-header");
    expect(header.getAttribute("data-state")).toBe("live");
    expect(screen.getByTestId("live-pill").textContent).toBe("Live");
    expect(screen.getByTestId("live-pause-button")).toBeInTheDocument();
  });
});