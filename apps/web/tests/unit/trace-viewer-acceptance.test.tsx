import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ObservationDetailPanel } from "../../src/components/ObservationDetailPanel";
import { TraceHeader } from "../../src/components/TraceHeader";
import { TraceWorkspace } from "../../src/components/TraceWorkspace";
import type { CanonicalObservation } from "../../src/lib/trace-model";

const TRACE_ID = "a".repeat(32);

function observation(overrides: Record<string, unknown> = {}): CanonicalObservation {
  return {
    observation_id: "root",
    parent_observation_id: null,
    name: "root operation",
    start_time: "2026-07-13 12:00:00.000",
    duration_ms: 100,
    status: "ok",
    type: "span",
    metadata: "{}",
    ...overrides,
  };
}

describe("trace viewer acceptance", () => {
  it("AC3: exposes the root service in the trace header", () => {
    render(
      <TraceHeader
        traceId={TRACE_ID}
        observations={[observation({ service_name: "payments-api" })]}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText("payments-api")).toBeInTheDocument();
  });

  it("AC3: lets a user copy the disclosed trace payload as raw JSON", () => {
    render(
      <TraceHeader
        traceId={TRACE_ID}
        observations={[observation()]}
        trace={{ trace_id: TRACE_ID }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /raw json/i }));

    expect(screen.getByRole("button", { name: /copy raw json/i })).toBeInTheDocument();
  });

  it("AC6: keeps the controlled selection while a collapsed ancestor visibly signals a descendant error", () => {
    const observations = [
      observation(),
      observation({
        observation_id: "failed-child",
        parent_observation_id: "root",
        name: "failed child",
        status: "error",
      }),
    ];
    render(
      <TraceWorkspace
        observations={observations}
        selectedObservationId="failed-child"
        onSelectObservation={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse root operation" }));

    const root = screen.getByTestId("span-row");
    expect(root).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Contains an error")).toBeInTheDocument();
  });

  it("AC8: provides navigation between search matches", () => {
    render(
      <TraceWorkspace
        observations={[
          observation(),
          observation({ observation_id: "matching-child", parent_observation_id: "root", name: "matching child" }),
        ]}
        selectedObservationId="root"
        onSelectObservation={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("trace-search"), { target: { value: "matching" } });

    expect(screen.getByTestId("trace-search-count")).toHaveTextContent("1 match");
    expect(screen.getByRole("button", { name: /next match/i })).toBeInTheDocument();
  });

  it("AC8: provides a zoom-to-fit control for the waterfall timing range", () => {
    render(
      <TraceWorkspace
        observations={[observation()]}
        selectedObservationId="root"
        onSelectObservation={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /zoom to fit/i })).toBeInTheDocument();
  });

  it("AC10: lets a user search attributes before copying a supplied value", () => {
    render(
      <ObservationDetailPanel
        traceId={TRACE_ID}
        observation={observation({
          metadata: JSON.stringify([
            { key: "zebra", value: "last" },
            { key: "agent.id", value: "agent-42" },
          ]),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Attributes" }));

    expect(screen.getByRole("searchbox", { name: /search attributes/i })).toBeInTheDocument();
  });

  it("AC12: exposes a non-color failure cue and supports ArrowDown tree navigation", () => {
    render(
      <TraceWorkspace
        observations={[
          observation(),
          observation({
            observation_id: "failed-child",
            parent_observation_id: "root",
            name: "failed child",
            status: "error",
          }),
        ]}
        selectedObservationId="root"
        onSelectObservation={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Error")).toBeInTheDocument();
    const rows = screen.getAllByTestId("span-row");
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });

    expect(document.activeElement).toBe(rows[1]);
  });
});
