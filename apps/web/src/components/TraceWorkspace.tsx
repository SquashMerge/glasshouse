import * as React from "react";
import { LuChevronDown, LuChevronRight, LuSearch, LuTriangleAlert, LuZoomIn, LuZoomOut } from "react-icons/lu";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";
import type { CanonicalObservation } from "../lib/trace-model";
import { observationKind } from "../lib/observation-kind";
import { searchTraceObservations, revealSearchAncestors } from "../lib/trace-search";
import { createTraceTimeline, observationTiming } from "../lib/trace-timeline";
import { buildTraceTree, traceTreeAncestorIds, visibleTraceRows, type ObservationTreeNode, type TraceTreeGroup } from "../lib/trace-tree";

export interface TraceWorkspaceProps {
  observations: readonly CanonicalObservation[];
  selectedObservationId: string | null;
  onSelectObservation: (observationId: string) => void;
  newObservationIds?: ReadonlySet<string>;
  highlightVersions?: ReadonlyMap<string, number>;
  malformedObservationCount?: number;
  onCloseInspector?: () => void;
  focusRequestVersion?: number;
}

type ViewMode = "waterfall" | "tree";

function formatDuration(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(2)}s`;
}

function observationName(observation: CanonicalObservation): string {
  return typeof observation.name === "string" && observation.name ? observation.name : "observation";
}

function defaultExpandedIds(tree: ReturnType<typeof buildTraceTree>): Set<string> {
  const expanded = new Set<string>();
  for (const root of tree.roots) {
    expanded.add(root.id);
    for (const child of root.children) expanded.add(child.id);
  }
  return expanded;
}

function isGroup(node: ObservationTreeNode | TraceTreeGroup): node is TraceTreeGroup {
  return node.kind === "group";
}

export function TraceWorkspace({
  observations,
  selectedObservationId,
  onSelectObservation,
  newObservationIds = new Set(),
  highlightVersions,
  malformedObservationCount = 0,
  onCloseInspector,
  focusRequestVersion = 0,
}: TraceWorkspaceProps) {
  const [viewMode, setViewMode] = React.useState<ViewMode>("waterfall");
  const [query, setQuery] = React.useState("");
  const [activeMatchIndex, setActiveMatchIndex] = React.useState<number | null>(null);
  const [timelineZoom, setTimelineZoom] = React.useState(1);
  const [focusTargetId, setFocusTargetId] = React.useState<string | null>(null);
  const [activeTreeItemId, setActiveTreeItemId] = React.useState<string | null>(selectedObservationId);
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
  const tree = React.useMemo(() => buildTraceTree(observations), [observations]);
  const timeline = React.useMemo(() => createTraceTimeline(observations), [observations]);
  const observationKey = React.useMemo(() => observations.map((observation) => observation.observation_id).join("\u0000"), [observations]);
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => defaultExpandedIds(tree));
  const expansionInitialized = React.useRef(observations.length > 0);

  React.useEffect(() => {
    if (expansionInitialized.current || observations.length === 0) return;
    setExpandedIds(defaultExpandedIds(tree));
    expansionInitialized.current = true;
  }, [observationKey]);

  React.useEffect(() => {
    if (!tree.roots.some((root) => root.id === "trace-root")) return;
    setExpandedIds((previous) => previous.has("trace-root") ? previous : new Set(previous).add("trace-root"));
  }, [tree]);

  const search = React.useMemo(() => searchTraceObservations(observations, query), [observations, query]);
  const matchingIds = React.useMemo(() => new Set(search.matchIds), [search.matchIds]);

  React.useEffect(() => {
    if (search.matchIds.length === 0) return;
    setExpandedIds((previous) => revealSearchAncestors(previous, search.matchIds, (id) => traceTreeAncestorIds(tree, id)));
  }, [search.matchIds, tree]);

  const rows = React.useMemo(() => visibleTraceRows(tree, expandedIds), [tree, expandedIds]);
  const barsById = React.useMemo(() => new Map(timeline.bars.map((bar) => [bar.observationId, bar])), [timeline.bars]);
  const isFiltered = query.trim().length > 0;
  const rootGroupByChildId = React.useMemo(() => {
    const groups = new Map<string, string>();
    for (const root of tree.roots) {
      if (!isGroup(root)) continue;
      for (const child of root.children) groups.set(child.id, root.id);
    }
    return groups;
  }, [tree]);
  const timelineMinWidth = `${42 * timelineZoom}rem`;

  React.useEffect(() => {
    setActiveMatchIndex(null);
  }, [query]);

  React.useEffect(() => {
    if (!focusTargetId) return;
    rowRefs.current.get(focusTargetId)?.focus();
    setFocusTargetId(null);
  }, [focusTargetId, rows]);

  React.useEffect(() => {
    setActiveTreeItemId((current) => {
      if (current && rows.some((row) => row.id === current)) return current;
      if (selectedObservationId && rows.some((row) => row.id === selectedObservationId)) return selectedObservationId;
      return rows[0]?.id ?? null;
    });
  }, [rows, selectedObservationId]);

  React.useEffect(() => {
    if (focusRequestVersion > 0) focusRow(selectedObservationId ?? rows[0]?.id);
  }, [focusRequestVersion]);

  function toggle(id: string) {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function expandAll() {
    setExpandedIds(new Set([...tree.nodesById.keys(), ...tree.roots.map((root) => root.id)]));
  }

  function collapseAll() {
    setExpandedIds(new Set());
  }

  function focusRow(id: string | undefined) {
    if (!id) return;
    setActiveTreeItemId(id);
    setFocusTargetId(id);
  }

  function navigateSearchMatch(direction: 1 | -1) {
    if (search.matchIds.length === 0) return;
    const nextIndex = activeMatchIndex === null
      ? direction === 1 ? 0 : search.matchIds.length - 1
      : (activeMatchIndex + direction + search.matchIds.length) % search.matchIds.length;
    const observationId = search.matchIds[nextIndex];
    if (!observationId) return;
    setActiveMatchIndex(nextIndex);
    onSelectObservation(observationId);
    setExpandedIds((previous) => revealSearchAncestors(previous, [observationId], (id) => traceTreeAncestorIds(tree, id)));
    focusRow(observationId);
  }

  function parentRowId(id: string, node: ObservationTreeNode | TraceTreeGroup): string | undefined {
    if (isGroup(node)) return undefined;
    return node.parentId ?? rootGroupByChildId.get(id);
  }

  function handleTreeKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
    id: string,
    node: ObservationTreeNode | TraceTreeGroup,
  ) {
    const index = rows.findIndex((row) => row.id === id);
    const hasChildren = node.children.length > 0;
    const expanded = expandedIds.has(id);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(rows[index + 1]?.id);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(rows[index - 1]?.id);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusRow(rows[0]?.id);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusRow(rows.at(-1)?.id);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (hasChildren && !expanded) toggle(id);
      else if (hasChildren) focusRow(rows[index + 1]?.id);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (hasChildren && expanded) toggle(id);
      else focusRow(parentRowId(id, node));
      return;
    }
    if (event.key === "Escape" && onCloseInspector) {
      event.preventDefault();
      onCloseInspector();
    }
  }

  if (observations.length === 0) {
    return <div className="rounded-lg border p-6 text-sm text-muted-foreground" data-testid="trace-workspace-empty">This trace contains no observations.</div>;
  }

  return (
    <section className="overflow-hidden rounded-lg border bg-card" data-testid="trace-workspace" data-row-count={observations.length}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-3">
        <div className="flex items-center gap-1" role="group" aria-label="Trace view">
          <Button type="button" size="sm" variant={viewMode === "waterfall" ? "secondary" : "ghost"} onClick={() => setViewMode("waterfall")} aria-pressed={viewMode === "waterfall"}>Waterfall</Button>
          <Button type="button" size="sm" variant={viewMode === "tree" ? "secondary" : "ghost"} onClick={() => setViewMode("tree")} aria-pressed={viewMode === "tree"}>Tree</Button>
        </div>
        <label className="relative min-w-52 flex-1 sm:max-w-xs">
          <span className="sr-only">Search observations</span>
          <LuSearch className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <Input type="search" className="h-8 pl-8 text-xs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search observations…" data-testid="trace-search" />
        </label>
        <div className="flex items-center gap-2">
          {isFiltered && (
            <>
              <span className="text-xs text-muted-foreground" data-testid="trace-search-count">{search.matchIds.length} match{search.matchIds.length === 1 ? "" : "es"}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => navigateSearchMatch(-1)} disabled={search.matchIds.length === 0} aria-label="Previous match">Previous match</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => navigateSearchMatch(1)} disabled={search.matchIds.length === 0} aria-label="Next match">Next match</Button>
            </>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={expandAll}>Expand all</Button>
          <Button type="button" size="sm" variant="ghost" onClick={collapseAll}>Collapse all</Button>
        </div>
      </div>

      {observations.length >= 2_000 && (
        <div className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" role="status" data-testid="large-trace-warning">
          <span className="font-medium">Large trace:</span> this trace has 2,000 or more observations, so rendering and filtering may be slower.
        </div>
      )}

      {viewMode === "waterfall" && (
        <div className="flex items-center justify-end gap-1 border-b px-3 py-1.5" role="group" aria-label="Timeline zoom">
          <Button type="button" size="sm" variant="ghost" onClick={() => setTimelineZoom((zoom) => Math.max(1, zoom / 1.25))} disabled={timelineZoom <= 1} aria-label="Zoom out">
            <LuZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setTimelineZoom((zoom) => Math.min(4, zoom * 1.25))} aria-label="Zoom in">
            <LuZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setTimelineZoom(1)} disabled={timelineZoom === 1} data-testid="zoom-to-fit">Zoom to fit</Button>
        </div>
      )}

      {(malformedObservationCount > 0 || tree.orphanIds.length > 0 || tree.cycleRootIds.length > 0) && (
        <div className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" role="status" data-testid="trace-diagnostics">
          <span className="font-medium">Trace data diagnostics:</span>{" "}
          {[
            malformedObservationCount > 0 ? `${malformedObservationCount} malformed observation${malformedObservationCount === 1 ? " was" : "s were"} ignored` : null,
            tree.orphanIds.length > 0 ? `${tree.orphanIds.length} observation${tree.orphanIds.length === 1 ? " has" : "s have"} a missing parent` : null,
            tree.cycleRootIds.length > 0 ? `${tree.cycleRootIds.length} parent cycle${tree.cycleRootIds.length === 1 ? " was" : "s were"} repaired` : null,
          ].filter(Boolean).join("; ")}.
        </div>
      )}

      {viewMode === "waterfall" && (
        <div className="grid min-w-[42rem] grid-cols-[minmax(18rem,1fr)_minmax(16rem,1fr)] border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground" style={{ minWidth: timelineMinWidth }} data-testid="timeline-ruler">
          <span>Observation</span>
          <span className="flex justify-between"><span>0 ms</span><span>{timeline.startMs !== null && timeline.endMs !== null ? formatDuration(timeline.endMs - timeline.startMs) : "Timing unavailable"}</span></span>
        </div>
      )}

      <div className="max-h-[34rem] overflow-auto" role="tree" aria-label="Trace observations" data-testid="span-tree">
        {rows.map(({ id, depth, node }) => {
          const group = isGroup(node);
          const hasChildren = node.children.length > 0;
          const expanded = expandedIds.has(id);
          if (group) {
            return (
              <div
                key={id}
                className="flex items-center border-b px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
                role="treeitem"
                aria-expanded={hasChildren ? expanded : undefined}
                tabIndex={id === activeTreeItemId ? 0 : -1}
                ref={(element) => {
                  if (element) rowRefs.current.set(id, element);
                  else rowRefs.current.delete(id);
                }}
                onKeyDown={(event) => handleTreeKeyDown(event, id, node)}
                onFocus={() => setActiveTreeItemId(id)}
              >
                {hasChildren && <TreeToggle expanded={expanded} onClick={() => toggle(id)} label={`${expanded ? "Collapse" : "Expand"} ${node.label}`} />}
                <span className="ml-1">{node.label}</span>
                {id === "orphaned-observations" && <LuTriangleAlert className="ml-2 h-4 w-4 text-amber-600" aria-label="Missing parent observations" />}
              </div>
            );
          }

          const { observation } = node;
          const kind = observationKind(observation.type);
          const bar = barsById.get(observation.observation_id);
          const timing = observationTiming(observation);
          const selected = selectedObservationId === observation.observation_id;
          const matched = matchingIds.has(observation.observation_id);
          const containsError = node.hasDescendantError && observation.status !== "error";
          const highlightVersion = highlightVersions?.get(id) ?? (newObservationIds.has(id) ? 1 : 0);
          return (
            <div
              key={id}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={hasChildren ? expanded : undefined}
              aria-selected={selected}
              tabIndex={id === activeTreeItemId ? 0 : -1}
              ref={(element) => {
                if (element) rowRefs.current.set(id, element);
                else rowRefs.current.delete(id);
              }}
              className={cn("grid cursor-pointer items-center border-b text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", viewMode === "waterfall" ? "min-w-[42rem] grid-cols-[minmax(18rem,1fr)_minmax(16rem,1fr)]" : "grid-cols-1", highlightVersion > 0 && "bg-accent/40", selected && "bg-accent/60", matched && "ring-1 ring-inset ring-primary/50")}
              style={viewMode === "waterfall" ? { minWidth: timelineMinWidth } : undefined}
              onClick={() => onSelectObservation(observation.observation_id)}
              onFocus={() => setActiveTreeItemId(id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectObservation(observation.observation_id);
                  return;
                }
                handleTreeKeyDown(event, id, node);
              }}
              data-testid="span-row"
              data-observation-id={observation.observation_id}
              data-selected={selected ? "true" : "false"}
               data-highlighted={highlightVersion > 0 ? "true" : "false"}
            >
              <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-left text-sm" style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}>
                {hasChildren ? <TreeToggle expanded={expanded} onClick={(event) => { event.stopPropagation(); toggle(id); }} label={`${expanded ? "Collapse" : "Expand"} ${observationName(observation)}`} /> : <span className="w-5" aria-hidden="true" />}
                <span className={cn("h-2 w-2 shrink-0 rounded-full", observation.status === "error" ? "bg-destructive" : "bg-emerald-500")} aria-label={observation.status === "error" ? "Error" : "OK"} />
                <span className="min-w-0 flex-1 truncate">{observationName(observation)}</span>
                <Badge variant="outline" className="shrink-0 text-[10px]">{kind.label}</Badge>
                {containsError && <LuTriangleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Contains an error" />}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(observation.duration_ms)}</span>
              </div>
              {viewMode === "waterfall" && (
                <div className="relative mr-3 h-8" data-testid="waterfall-cell">
                  {bar ? (
                    <button
                      type="button"
                      className={cn("absolute top-2 h-4 min-w-1 rounded-sm bg-primary/70 hover:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", observation.status === "error" && "border-l-2 border-destructive", selected && "bg-primary")}
                      style={{ left: `${bar.leftPercent}%`, width: `${Math.max(bar.widthPercent, 0.15)}%` }}
                      onClick={() => onSelectObservation(observation.observation_id)}
                      title={`${observationName(observation)}: ${formatDuration(observation.duration_ms)} (${String(observation.status)})`}
                      aria-label={`Select ${observationName(observation)} waterfall bar`}
                      data-testid="waterfall-bar"
                    />
                  ) : (
                    <span className="text-xs text-amber-700" data-testid="timing-warning">Timing unavailable: {timing.warnings.join(", ") || "unknown timing"}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TreeToggle({ expanded, onClick, label }: { expanded: boolean; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; label: string }) {
  return (
    <button type="button" className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onClick} aria-label={label}>
      {expanded ? <LuChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <LuChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  );
}
