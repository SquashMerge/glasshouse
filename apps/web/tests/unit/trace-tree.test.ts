import { describe, expect, it } from "vitest";
import { buildTraceTree, traceTreeAncestorIds, visibleTraceRows } from "../../src/lib/trace-tree";

const observation = (observation_id: string, parent_observation_id: string | null = null, extra: Record<string, unknown> = {}) => ({
  observation_id,
  parent_observation_id,
  start_time: "2026-01-01 00:00:00.000",
  duration_ms: 10,
  status: "ok",
  ...extra,
});

describe("trace tree", () => {
  it("sorts nodes by valid start, descending duration, then ID", () => {
    const tree = buildTraceTree([
      observation("c", null, { duration_ms: 2 }),
      observation("b", null, { duration_ms: 5 }),
      observation("a", null, { start_time: "not-a-date" }),
    ]);
    const root = tree.roots[0];

    expect(root?.kind).toBe("group");
    expect(root?.kind === "group" && root.children.map((node) => node.id)).toEqual(["b", "c", "a"]);
  });

  it("places missing parents in a synthetic orphan group", () => {
    const tree = buildTraceTree([observation("root"), observation("orphan", "missing")]);

    expect(tree.orphanIds).toEqual(["orphan"]);
    expect(tree.roots.at(-1)).toMatchObject({ kind: "group", id: "orphaned-observations" });
  });

  it("detaches the lexicographically greatest member of a parent cycle", () => {
    const tree = buildTraceTree([
      observation("a", "b"),
      observation("b", "c"),
      observation("c", "a"),
    ]);

    expect(tree.cycleRootIds).toEqual(["c"]);
    expect(tree.nodesById.get("c")?.parentId).toBeNull();
    expect(tree.nodesById.get("a")?.parentId).toBe("b");
  });

  it("derives descendant error state and visible rows from expansion", () => {
    const tree = buildTraceTree([
      observation("root"),
      observation("child", "root", { status: "error" }),
    ]);
    const root = tree.nodesById.get("root");

    expect(root?.hasDescendantError).toBe(true);
    expect(visibleTraceRows(tree, new Set())).toHaveLength(1);
    expect(visibleTraceRows(tree, new Set(["root"])).map((row) => row.id)).toEqual(["root", "child"]);
    expect(traceTreeAncestorIds(tree, "child")).toEqual(["root"]);
  });

  it("includes synthetic group ancestors when revealing a search result", () => {
    const tree = buildTraceTree([observation("one"), observation("two")]);

    expect(traceTreeAncestorIds(tree, "one")).toEqual(["trace-root"]);
  });
});
