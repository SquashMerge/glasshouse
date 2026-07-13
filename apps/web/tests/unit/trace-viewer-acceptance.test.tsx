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

  it("AC3: prefers the trace name and reads an OTLP root-service attribute", () => {
    render(
      <TraceHeader
        traceId={TRACE_ID}
        trace={{ name: "checkout request" }}
        observations={[observation({ metadata: JSON.stringify([{ key: "service.name", value: { stringValue: "checkout-api" } }]) })]}
      />,
    );

    expect(screen.getByTestId("trace-name")).toHaveTextContent("checkout request");
    expect(screen.getByTestId("trace-root-service")).toHaveTextContent("checkout-api");
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
    const onSelectObservation = vi.fn();
    render(
      <TraceWorkspace
        observations={[
          observation(),
          observation({ observation_id: "matching-child", parent_observation_id: "root", name: "matching child" }),
          observation({ observation_id: "other-matching-child", parent_observation_id: "root", name: "other matching child" }),
        ]}
        selectedObservationId="root"
        onSelectObservation={onSelectObservation}
      />,
    );

    fireEvent.change(screen.getByTestId("trace-search"), { target: { value: "matching" } });

    expect(screen.getByTestId("trace-search-count")).toHaveTextContent("2 matches");
    expect(screen.getByRole("button", { name: /next match/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /next match/i }));

    expect(onSelectObservation).toHaveBeenCalledWith("matching-child");
    expect(document.activeElement).toHaveAttribute("data-observation-id", "matching-child");
  });

  it("AC8: provides a zoom-to-fit control for the waterfall timing range", () => {
    render(
      <TraceWorkspace
        observations={[observation()]}
        selectedObservationId="root"
        onSelectObservation={vi.fn()}
      />,
    );

    const ruler = screen.getByTestId("timeline-ruler");
    expect(ruler).toHaveStyle({ minWidth: "42rem" });

    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(ruler).toHaveStyle({ minWidth: "52.5rem" });

    fireEvent.click(screen.getByRole("button", { name: /zoom to fit/i }));
    expect(ruler).toHaveStyle({ minWidth: "42rem" });
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

    const search = screen.getByRole("searchbox", { name: /search attributes/i });
    fireEvent.change(search, { target: { value: "agent" } });

    expect(screen.getByText("agent.id")).toBeInTheDocument();
    expect(screen.queryByText("zebra")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy agent.id value/i })).toBeInTheDocument();
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
    expect(rows[0]).toHaveAttribute("tabindex", "0");
    expect(rows[1]).toHaveAttribute("tabindex", "-1");
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });

    expect(document.activeElement).toBe(rows[1]);

    fireEvent.keyDown(rows[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]);

    fireEvent.keyDown(rows[0]!, { key: "ArrowLeft" });
    expect(rows[0]).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(rows[0]!, { key: "ArrowRight" });
    expect(rows[0]).toHaveAttribute("aria-expanded", "true");
  });
});
