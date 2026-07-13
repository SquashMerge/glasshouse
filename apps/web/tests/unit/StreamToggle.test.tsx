import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  StreamToggle,
  type StreamController,
} from "../../src/components/StreamToggle";

function makeController(overrides: Partial<StreamController> = {}): StreamController {
  let paused = overrides.paused ?? false;
  let status: "connecting" | "open" | "closed" = "open";
  return {
    get paused() {
      return paused;
    },
    get status() {
      return status;
    },
    reconnect: vi.fn((opts?: { pause?: boolean }) => {
      if (opts?.pause !== undefined) {
        paused = opts.pause;
        status = opts.pause ? "closed" : "open";
      }
    }),
    ...overrides,
  } as unknown as StreamController;
}

beforeEach(() => {
  // sessionStorage survives across tests if not reset.
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("StreamToggle", () => {
  it("renders On / Streaming when SSE is open and not paused", () => {
    const sse = makeController({ paused: false });
    render(<StreamToggle sse={sse} />);
    const toggle = screen.getByTestId("stream-toggle");
    expect(toggle.getAttribute("data-state")).toBe("on-open");
    const button = screen.getByTestId("stream-toggle-button");
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(button.textContent).toMatch(/Streaming/);
  });

  it("renders Connecting while the connection is still being established", () => {
    const sse = makeController({ paused: false });
    Object.defineProperty(sse, "status", {
      get() {
        return "connecting";
      },
    });
    render(<StreamToggle sse={sse} />);
    expect(screen.getByTestId("stream-toggle").getAttribute("data-state")).toBe("on-connecting");
    expect(screen.getByTestId("stream-toggle-button").textContent).toMatch(/Connecting/);
  });

  it("renders Reconnecting when the connection is closed and not paused", () => {
    const sse = makeController({ paused: false });
    Object.defineProperty(sse, "status", {
      get() {
        return "closed";
      },
    });
    render(<StreamToggle sse={sse} />);
    expect(screen.getByTestId("stream-toggle").getAttribute("data-state")).toBe("on-reconnecting");
    expect(screen.getByTestId("stream-toggle-button").textContent).toMatch(/Reconnecting/);
  });

  it("renders Off / Paused when paused", () => {
    const sse = makeController({ paused: true });
    render(<StreamToggle sse={sse} />);
    expect(screen.getByTestId("stream-toggle").getAttribute("data-state")).toBe("off");
    const button = screen.getByTestId("stream-toggle-button");
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(button.textContent).toMatch(/Paused/);
  });

  it("clicking the toggle calls reconnect({pause: true}) when currently on", () => {
    const sse = makeController({ paused: false });
    render(<StreamToggle sse={sse} />);
    fireEvent.click(screen.getByTestId("stream-toggle-button"));
    expect(sse.reconnect).toHaveBeenCalledWith({ pause: true });
  });

  it("clicking the toggle calls reconnect({pause: false}) when currently off", () => {
    const sse = makeController({ paused: true });
    render(<StreamToggle sse={sse} />);
    fireEvent.click(screen.getByTestId("stream-toggle-button"));
    expect(sse.reconnect).toHaveBeenCalledWith({ pause: false });
  });
});
