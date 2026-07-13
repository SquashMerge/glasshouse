import { canonicalizeObservation, type CanonicalObservation } from "./trace-model";
import { parseClickHouseUtc } from "./trace-timeline";

export interface ObservationTreeNode {
  kind: "observation";
  id: string;
  observation: CanonicalObservation;
  parentId: string | null;
  children: ObservationTreeNode[];
  hasDescendantError: boolean;
}

export interface TraceTreeGroup {
  kind: "group";
  id: "trace-root" | "orphaned-observations";
  label: string;
  children: ObservationTreeNode[];
}

export interface TraceTree {
  roots: Array<ObservationTreeNode | TraceTreeGroup>;
  nodesById: ReadonlyMap<string, ObservationTreeNode>;
  malformedObservationCount: number;
  orphanIds: readonly string[];
  cycleRootIds: readonly string[];
}

export interface VisibleTreeRow {
  id: string;
  depth: number;
  node: ObservationTreeNode | TraceTreeGroup;
}

function validDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareObservations(left: ObservationTreeNode, right: ObservationTreeNode): number {
  const leftStart = parseClickHouseUtc(left.observation.start_time);
  const rightStart = parseClickHouseUtc(right.observation.start_time);
  if (leftStart !== null && rightStart === null) return -1;
  if (leftStart === null && rightStart !== null) return 1;
  if (leftStart !== null && rightStart !== null && leftStart !== rightStart) return leftStart - rightStart;
  const leftDuration = validDuration(left.observation.duration_ms) ?? Number.NEGATIVE_INFINITY;
  const rightDuration = validDuration(right.observation.duration_ms) ?? Number.NEGATIVE_INFINITY;
  if (leftDuration !== rightDuration) return rightDuration - leftDuration;
  return left.id.localeCompare(right.id);
}

function canonicalParentId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function buildTraceTree(values: readonly unknown[]): TraceTree {
  const nodesById = new Map<string, ObservationTreeNode>();
  let malformedObservationCount = 0;
  for (const value of values) {
    const observation = canonicalizeObservation(value);
    if (!observation) {
      malformedObservationCount += 1;
      continue;
    }
    nodesById.set(observation.observation_id, {
      kind: "observation",
      id: observation.observation_id,
      observation,
      parentId: canonicalParentId(observation.parent_observation_id),
      children: [],
      hasDescendantError: false,
    });
  }

  const cycleRootIds = new Set<string>();
  for (const id of nodesById.keys()) {
    const seen = new Map<string, number>();
    const path: string[] = [];
    let currentId: string | null = id;
    while (currentId !== null && nodesById.has(currentId) && !seen.has(currentId)) {
      seen.set(currentId, path.length);
      path.push(currentId);
      currentId = nodesById.get(currentId)?.parentId ?? null;
    }
    if (currentId !== null && seen.has(currentId)) {
      const cycle = path.slice(seen.get(currentId));
      const detachedId = [...cycle].sort().at(-1);
      if (detachedId) {
        nodesById.get(detachedId)!.parentId = null;
        cycleRootIds.add(detachedId);
      }
    }
  }

  const roots: ObservationTreeNode[] = [];
  const orphans: ObservationTreeNode[] = [];
  for (const node of nodesById.values()) {
    if (node.parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = nodesById.get(node.parentId);
    if (parent) parent.children.push(node);
    else orphans.push(node);
  }

  const sortNodes = (nodes: ObservationTreeNode[]): void => {
    nodes.sort(compareObservations);
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  sortNodes(orphans);

  const markErrors = (node: ObservationTreeNode): boolean => {
    const ownError = node.observation.status === "error";
    const childError = node.children.some(markErrors);
    node.hasDescendantError = childError;
    return ownError || childError;
  };
  roots.forEach(markErrors);
  orphans.forEach(markErrors);

  const groupedRoots: Array<ObservationTreeNode | TraceTreeGroup> = roots.length > 1
    ? [{ kind: "group", id: "trace-root", label: "Trace", children: roots }]
    : [...roots];
  if (orphans.length > 0) {
    groupedRoots.push({ kind: "group", id: "orphaned-observations", label: "Orphaned observations", children: orphans });
  }
  return {
    roots: groupedRoots,
    nodesById,
    malformedObservationCount,
    orphanIds: orphans.map((node) => node.id),
    cycleRootIds: [...cycleRootIds].sort(),
  };
}

export function visibleTraceRows(tree: TraceTree, expandedIds: ReadonlySet<string>): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];
  const visit = (node: ObservationTreeNode | TraceTreeGroup, depth: number): void => {
    rows.push({ id: node.id, depth, node });
    if (!expandedIds.has(node.id)) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of tree.roots) visit(root, 0);
  return rows;
}

export function traceTreeAncestorIds(tree: TraceTree, observationId: string): string[] {
  const ancestors: string[] = [];
  let node = tree.nodesById.get(observationId);
  while (node?.parentId) {
    const parent = tree.nodesById.get(node.parentId);
    if (!parent) break;
    ancestors.push(parent.id);
    node = parent;
  }
  if (node) {
    const containingGroup = tree.roots.find((root): root is TraceTreeGroup => (
      root.kind === "group" && root.children.some((child) => child.id === node.id)
    ));
    if (containingGroup) ancestors.push(containingGroup.id);
  }
  return ancestors;
}
