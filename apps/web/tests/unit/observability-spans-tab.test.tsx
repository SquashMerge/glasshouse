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
  return {
    ...actual,
    listObservations: vi.fn(async () => ({ items: [], total: 0 })),
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
  it("appends an SSE event row with the highlight class", async () => {
    renderWithQueryClient(<SpansTab />);

    await waitFor(() => expect(pushEvent).not.toBeNull());

    act(() => {
      pushEvent!({ event: "observation", data: makeSpanEvent({ name: "first-span" }) });
    });

    const cell = await screen.findByText("first-span");
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-highlighted")).toBe("true");
  });

  it("navigates to /observability/traces/{32-hex}?span={obs_id} on row click", async () => {
    renderWithQueryClient(<SpansTab />);

    await waitFor(() => expect(pushEvent).not.toBeNull());

    act(() => {
      pushEvent!({
        event: "observation",
        data: makeSpanEvent({ observation_id: SPAN_ID, trace_id: TRACE_ID, name: "clickable-span" }),
      });
    });

    const cell = await screen.findByText("clickable-span");
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const call = navigate.mock.calls[0]?.[0] as { to: string; search?: { span?: string } };
    expect(call.to).toBe(`/observability/traces/${TRACE_ID}`);
    expect(call.search?.span).toBe(SPAN_ID);
  });

  it("uses metadataParsed to populate tool/model/type cells when present", async () => {
    renderWithQueryClient(<SpansTab />);

    await waitFor(() => expect(pushEvent).not.toBeNull());

    act(() => {
      pushEvent!({
        event: "observation",
        data: makeSpanEvent({
          observation_id: SPAN_ID,
          name: "metadata-span",
          // metadataParsed overrides name/type/model without a second fetch.
          metadataParsed: {
            tool: { name: "tool-from-metadata" },
            model: "gpt-4o-from-metadata",
            type: "tool",
          },
        }),
      });
    });

    // The Name column reads from metadataParsed.tool.name first.
    expect(await screen.findByText("tool-from-metadata")).toBeInTheDocument();
    // The Model column reads from metadataParsed.model.
    expect(await screen.findByText("gpt-4o-from-metadata")).toBeInTheDocument();
    // The Type badge shows "tool" (overridden by metadataParsed.type).
    const badges = screen.getAllByText("tool");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("renders a Live pill + Pause button on the SpansTab header", async () => {
    renderWithQueryClient(<SpansTab />);
    const header = await screen.findByTestId("live-tab-header");
    expect(header.getAttribute("data-state")).toBe("live");
    expect(screen.getByTestId("live-pill").textContent).toBe("Live");
    expect(screen.getByTestId("live-pause-button")).toBeInTheDocument();
  });
});