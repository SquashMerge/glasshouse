import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TraceWorkspace } from "../../src/components/TraceWorkspace";
import type { CanonicalObservation } from "../../src/lib/trace-model";

describe("trace workspace 5k release gate", () => {
  it("renders every observation with stable browser selectors", () => {
    const observations: CanonicalObservation[] = Array.from({ length: 5_000 }, (_, index) => ({
      observation_id: `observation-${index.toString().padStart(4, "0")}`,
      parent_observation_id: null,
      name: `operation ${index}`,
      start_time: "2026-07-13 12:00:00.000",
      duration_ms: 10,
      status: "ok",
      type: "span",
    }));

    render(<TraceWorkspace observations={observations} selectedObservationId={observations[0]!.observation_id} onSelectObservation={vi.fn()} />);

    const rows = screen.getAllByTestId("span-row");
    expect(rows).toHaveLength(5_000);
    expect(screen.getByTestId("span-tree")).toHaveAttribute("role", "tree");
    expect(rows[0]).toHaveAttribute("data-observation-id", "observation-0000");
  });
});
