import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SpanTree, type ObservationLike } from "../../src/components/SpanTree";

const obs = (
  partial: Partial<ObservationLike> & { observation_id: string; parent_observation_id: string | null; name: string },
): ObservationLike => ({
  trace_id: "trace1",
  project_id: "",
  type: "span",
  start_time: "2026-01-01T00:00:00Z",
  end_time: "2026-01-01T00:00:01Z",
  duration_ms: 1000,
  status: "ok",
  model: null,
  input_text: "",
  output_text: "",
  ...partial,
});

describe("SpanTree", () => {
  it("returns 'No observations' for empty input", () => {
    render(<SpanTree observations={[]} />);
    expect(screen.getByText(/No observations/i)).toBeInTheDocument();
  });

  it("renders a single root span as a top-level node", () => {
    render(
      <SpanTree
        observations={[
          obs({ observation_id: "a".repeat(16), parent_observation_id: null, name: "root" }),
        ]}
      />,
    );
    expect(screen.getByText("root")).toBeInTheDocument();
  });

  it("groups children under their parent", () => {
    render(
      <SpanTree
        observations={[
          obs({ observation_id: "a".repeat(16), parent_observation_id: null, name: "root" }),
          obs({ observation_id: "b".repeat(16), parent_observation_id: "a".repeat(16), name: "child1" }),
          obs({ observation_id: "c".repeat(16), parent_observation_id: "a".repeat(16), name: "child2" }),
        ]}
      />,
    );
    expect(screen.getByText("root")).toBeInTheDocument();
    expect(screen.getByText("child1")).toBeInTheDocument();
    expect(screen.getByText("child2")).toBeInTheDocument();
    expect(screen.getByText(/2 children/i)).toBeInTheDocument();
  });

  it("renders a grandchild nested under its parent", () => {
    render(
      <SpanTree
        observations={[
          obs({ observation_id: "a".repeat(16), parent_observation_id: null, name: "root" }),
          obs({ observation_id: "b".repeat(16), parent_observation_id: "a".repeat(16), name: "child" }),
          obs({ observation_id: "c".repeat(16), parent_observation_id: "b".repeat(16), name: "grandchild" }),
        ]}
      />,
    );
    expect(screen.getByText("root")).toBeInTheDocument();
    expect(screen.getByText("child")).toBeInTheDocument();
    expect(screen.getByText("grandchild")).toBeInTheDocument();
  });

  it("shows input/output text when present", () => {
    render(
      <SpanTree
        observations={[
          obs({
            observation_id: "a".repeat(16),
            parent_observation_id: null,
            name: "llm",
            input_text: "Hello world",
            output_text: "Hi!",
          }),
        ]}
      />,
    );
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(screen.getByText("Hi!")).toBeInTheDocument();
  });

  it("renders duration in ms or s as appropriate", () => {
    const { rerender } = render(
      <SpanTree
        observations={[
          obs({ observation_id: "a".repeat(16), parent_observation_id: null, name: "fast", duration_ms: 250 }),
        ]}
      />,
    );
    expect(screen.getByText("250ms")).toBeInTheDocument();

    rerender(
      <SpanTree
        observations={[
          obs({ observation_id: "b".repeat(16), parent_observation_id: null, name: "slow", duration_ms: 3500 }),
        ]}
      />,
    );
    expect(screen.getByText("3.50s")).toBeInTheDocument();
  });

  it("renders model badge when model is set", () => {
    render(
      <SpanTree
        observations={[
          obs({
            observation_id: "a".repeat(16),
            parent_observation_id: null,
            name: "llm",
            model: "gpt-4o",
          }),
        ]}
      />,
    );
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
  });
});