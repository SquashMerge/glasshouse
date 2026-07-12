import { describe, it, expect } from "vitest";
import type { ObservationRow } from "../../src/lib/api";

/**
 * Sanity test that the deduplicated `ObservationRow` interface compiles and
 * survives a JSON round-trip. After the `fe-filterable-refactor` slice, the
 * interface declares a single canonical shape including `project_id` and a
 * JSON-encoded `metadata` string. This file catches future regressions where
 * someone re-declares the interface (the original duplication silently
 * merged via TS declaration merging).
 */
describe("ObservationRow shape", () => {
  function makeRow(overrides: Partial<ObservationRow> = {}): ObservationRow {
    return {
      observation_id: "0123456789abcdef0123456789abcdef",
      trace_id: "abcdef0123456789abcdef0123456789",
      project_id: "proj-1",
      parent_observation_id: null,
      type: "span",
      name: "root",
      start_time: "2026-01-01 00:00:00",
      end_time: "2026-01-01 00:00:01",
      duration_ms: 1000,
      status: "ok",
      model: null,
      input_text: "",
      output_text: "",
      metadata: "{}",
      ...overrides,
    };
  }

  it("canonical fields are present and required", () => {
    const row = makeRow();
    expect(row.project_id).toBe("proj-1");
    expect(row.metadata).toBe("{}");
    expect(typeof row.observation_id).toBe("string");
    expect(typeof row.trace_id).toBe("string");
    expect(["span", "event", "generation", "tool"]).toContain(row.type);
  });

  it("round-trips through JSON.parse(JSON.stringify(o))", () => {
    const original = makeRow({
      metadata: JSON.stringify({ tool: { name: "search" }, tokens: 42 }),
      type: "tool",
      name: "search",
      model: "gpt-4o",
      parent_observation_id: "0123456789abcdef0123456789abcdee",
    });
    const round = JSON.parse(JSON.stringify(original)) as ObservationRow;
    expect(round).toEqual(original);
    expect(JSON.parse(round.metadata)).toEqual({ tool: { name: "search" }, tokens: 42 });
  });

  it("allows metadataParsed-style objects to be JSON-encoded into metadata", () => {
    const parsed = { tool: { name: "search_db" }, model: "gpt-4o", type: "tool" };
    const row = makeRow({
      type: "tool",
      name: parsed.tool.name,
      model: parsed.model,
      metadata: JSON.stringify(parsed),
    });
    const back = JSON.parse(row.metadata) as typeof parsed;
    expect(back).toEqual(parsed);
  });
});