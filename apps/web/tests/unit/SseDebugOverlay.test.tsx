import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SseDebugOverlay } from "../../src/components/SseDebugOverlay";
import type { UseEventSourceResult } from "../../src/hooks/useEventSource";

/**
 * Vitest runs in dev mode (Vite's `import.meta.env.DEV` resolves to `true`),
 * so the overlay renders by default. We exercise the dev path here and verify
 * the production short-circuit by mocking `import.meta.env.DEV` per test.
 */

function makeSse(overrides: Partial<UseEventSourceResult> = {}): UseEventSourceResult {
  let status: UseEventSourceResult["status"] = "open";
  let paused = false;
  let lastEventAt = Date.now();
  const debug = {
    framesReceived: 12,
    bufferDepth: 0,
    reconnectAttempts: 0,
    lastError: null,
  };
  return {
    get status() {
      return status;
    },
    get paused() {
      return paused;
    },
    get lastEventAt() {
      return lastEventAt;
    },
    reconnect: vi.fn(),
    get debug() {
      return debug;
    },
    ...overrides,
  } as unknown as UseEventSourceResult;
}

beforeEach(() => {
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SseDebugOverlay (dev only)", () => {
  it("renders nothing when devMode is false", () => {
    render(<SseDebugOverlay sse={makeSse()} label="traces" devMode={false} />);
    expect(screen.queryByTestId("sse-debug-overlay")).toBeNull();
  });

  it("renders the live state card with stats when devMode is true", () => {
    render(<SseDebugOverlay sse={makeSse()} label="traces" devMode={true} />);
    expect(screen.getByTestId("sse-debug-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("sse-debug-label").textContent).toMatch(/traces/);
    expect(screen.getByTestId("sse-debug-status").textContent).toBe("open");
    expect(screen.getByTestId("sse-debug-paused").textContent).toBe("false");
    expect(screen.getByTestId("sse-debug-framesReceived").textContent).toBe("12");
    expect(screen.getByTestId("sse-debug-bufferDepth").textContent).toBe("0");
    expect(screen.getByTestId("sse-debug-reconnectAttempts").textContent).toBe("0");
    expect(screen.getByTestId("sse-debug-lastError").textContent).toBe("—");
  });

  it("dismiss button hides the overlay and persists dismissal across re-mounts", () => {
    const sse = makeSse();
    const { unmount } = render(<SseDebugOverlay sse={sse} label="traces" devMode={true} />);
    expect(screen.getByTestId("sse-debug-overlay")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sse-debug-dismiss"));
    expect(screen.queryByTestId("sse-debug-overlay")).toBeNull();

    unmount();
    render(<SseDebugOverlay sse={sse} label="traces" devMode={true} />);
    expect(screen.queryByTestId("sse-debug-overlay")).toBeNull();
  });

  it("force-reconnect button calls sse.reconnect()", () => {
    const sse = makeSse();
    render(<SseDebugOverlay sse={sse} label="traces" devMode={true} />);
    fireEvent.click(screen.getByTestId("sse-debug-reconnect"));
    expect(sse.reconnect).toHaveBeenCalledTimes(1);
  });

  it("seeds one trace with a random number of spans through OTLP", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ partial_success: {} })));
    vi.stubGlobal("fetch", fetchMock);
    render(<SseDebugOverlay sse={makeSse()} label="traces" devMode={true} />);

    fireEvent.click(screen.getByTestId("sse-debug-seed"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    const spans = payload.resource_spans[0].scope_spans[0].spans;
    expect(url).toBe("/v1/otel/v1/traces");
    expect(init.method).toBe("POST");
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(spans.length).toBeLessThanOrEqual(10);
    expect(new Set(spans.map((span: { trace_id: string }) => span.trace_id)).size).toBe(1);
  });
});
