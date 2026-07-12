import * as React from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LuActivity, LuListTree } from "react-icons/lu";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  FilterableTable,
  type ColumnDef,
  type FilterFieldDef,
} from "../components/FilterableTable";
import {
  listTraces,
  listObservations,
  type ListTracesParams,
  type ListObservationsParams,
  type TraceRow,
  type ObservationRow,
} from "../lib/api";
import { defaultRange, toApiParams, type TimeRange } from "../components/TimeRangePicker";
import { useEventSource, type UseEventSourceResult } from "../hooks/useEventSource";
type Tab = "traces" | "spans";

/**
 * `LiveTabHeader` — small UX strip rendered in `FilterableTable.headerActions`.
 * Shows a colored pill for the SSE pipe state + Pause/Resume. Three visible
 * states from `useEventSource`:
 *   - status=open & !paused  → "Live" + Pause button
 *   - status=open & paused   → "Paused" + Resume button
 *   - status=closed & !paused → "Reconnecting" + Pause button
 * `paused: false` on auto-hidden-close → Reconnecting (the auto-close path).
 */
function LiveTabHeader({ sse }: { sse: UseEventSourceResult }): React.ReactElement {
  const label: { text: string; tone: "live" | "paused" | "reconnecting" } = (() => {
    if (sse.paused) return { text: "Paused", tone: "paused" };
    if (sse.status === "open") return { text: "Live", tone: "live" };
    return { text: "Reconnecting", tone: "reconnecting" };
  })();

  const pillClass =
    label.tone === "live"
      ? "bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/30"
      : label.tone === "paused"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
        : "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30";

  return (
    <div
      className="flex items-center gap-2"
      data-testid="live-tab-header"
      data-state={label.tone}
      aria-live="polite"
    >
      <Badge variant="outline" className={`text-[10px] font-mono uppercase tracking-wider ${pillClass}`} data-testid="live-pill">
        {label.text}
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => sse.reconnect({ pause: !sse.paused })}
        data-testid={sse.paused ? "live-resume-button" : "live-pause-button"}
      >
        {sse.paused ? "Resume" : "Pause"}
      </Button>
    </div>
  );
}

const VALID_TABS = new Set<Tab>(["traces", "spans"]);

export function ObservabilityPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.searchStr);
  const rawTab = searchParams.get("tab");
  const tab: Tab = VALID_TABS.has(rawTab as Tab) ? (rawTab as Tab) : "traces";

  function setTab(next: Tab) {
    navigate({ to: "/observability", search: { tab: next } });
  }

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="traces" className="gap-1.5">
            <LuListTree className="h-3.5 w-3.5" />
            Traces
          </TabsTrigger>
          <TabsTrigger value="spans" className="gap-1.5">
            <LuActivity className="h-3.5 w-3.5" />
            Spans
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "traces" ? <TracesTab /> : <SpansTab />}
    </div>
  );
}

const TRACE_COLUMNS: ColumnDef<TraceRow>[] = [
  {
    header: "Time",
    width: "w-[180px]",
    cell: (t) => <span className="font-mono text-xs">{new Date(t.start_time).toLocaleString()}</span>,
  },
  {
    header: "Name",
    width: "w-[180px]",
    cell: (t) => <span className="font-medium">{t.name}</span>,
  },
  {
    header: "Agent",
    width: "w-[160px]",
    className: "text-xs text-muted-foreground",
    cell: (t) => t.agent_id || "—",
  },
  {
    header: "Status",
    width: "w-[100px]",
    cell: (t) => <Badge variant={t.status === "error" ? "destructive" : "success"}>{t.status}</Badge>,
  },
  {
    header: "Duration",
    width: "w-[110px]",
    className: "text-xs",
    cell: (t) => (t.duration_ms !== null ? `${t.duration_ms}ms` : "—"),
  },
  {
    header: "Score",
    width: "w-[180px]",
    className: "text-xs text-muted-foreground",
    cell: (t) => t.scores_summary || "—",
  },
  {
    header: "Input excerpt",
    className: "max-w-md truncate text-xs text-muted-foreground",
    cell: (t) => t.input_text || "—",
  },
];

const TRACE_FILTER_FIELDS: FilterFieldDef[] = [
  { key: "name", placeholder: "e.g. llm.call or tool.search_db" },
  { key: "agent_id", placeholder: "e.g. code-reviewer" },
  { key: "status", placeholder: "ok / error", className: "font-mono" },
  { key: "duration", placeholder: "e.g. <500 or >1000", className: "font-mono" },
  { key: "scores", placeholder: "e.g. input_tokens", className: "font-mono" },
  { key: "input_text", placeholder: "e.g. recruiter or SQL" },
];

function buildTraceApiParams(filters: Record<string, string>, timeRange: TimeRange): ListTracesParams {
  const out: ListTracesParams = {};
  if (filters.name) out.name = filters.name;
  if (filters.agent_id) out.agent_id = filters.agent_id;
  if (filters.status) out.status = filters.status;
  if (filters.duration) out.duration = filters.duration;
  if (filters.scores) out.scores = filters.scores;
  if (filters.input_text) out.input_text = filters.input_text;
  const tr = toApiParams(timeRange);
  if (tr.time_from) out.time_from = tr.time_from;
  if (tr.time_to) out.time_to = tr.time_to;
  return out;
}

export interface TraceEvent {
  trace_id: string;
  project_id?: string;
  name: string;
  start_time: string;
  end_time?: string | null;
  duration_ms?: number | null;
  status: "ok" | "error";
  user_id?: string;
  session_id?: string;
  agent_id?: string;
  agent_version?: string;
  env?: string;
  tags?: string[];
  input_text?: string;
  output_text?: string;
  scores_summary?: string;
}

const PAGE_SIZE = 100;

/**
 * Cap on the `streamedRows` map per page tab. Each live SSE event costs one
 * entry; we drop the oldest (FIFO) beyond this to keep the rendered list
 * bounded regardless of SSE rate. The full set is still fetched via REST
 * on the next filter change / window-focus refetch.
 */
const STREAMED_CAP = 200;

/**
 * Map-based merge with dedup by id. SSE rows win over paginated rows for
 * the same id (last-write-wins), so SSE-driven field updates (status,
 * duration_ms, metadataParsed-derived name/type/model) propagate to the
 * cells immediately instead of waiting for the next REST refetch.
 *
 * Result is sorted by `start_time` DESC so newer items render at the top
 * regardless of which source they came from. Without the sort, SSE rows
 * (appended after REST) would render at the bottom — confusing for a
 * "Live" tab.
 */
function mergeByIdDesc<TRow extends { start_time: string }>(
  keyOf: (row: TRow) => string,
  paginated: ReadonlyArray<TRow>,
  streamed: ReadonlyMap<string, TRow>,
): TRow[] {
  const map = new Map<string, TRow>();
  for (const r of paginated) map.set(keyOf(r), r);
  for (const r of streamed.values()) map.set(keyOf(r), r);
  return Array.from(map.values()).sort((a, b) => b.start_time.localeCompare(a.start_time));
}

/**
 * Hook that owns the data fetch for TracesTab and the SSE merge. Exposed so
 * the test file can also import it (and so we keep `TracesTab` small).
 */
function useTracesData() {
  const [filters, setFilters] = React.useState<Record<string, string>>(() => emptyFilters(TRACE_FILTER_FIELDS));
  const [timeRange, setTimeRange] = React.useState<TimeRange>(defaultRange());
  const [debouncedFilters, setDebouncedFilters] = React.useState<Record<string, string>>(filters);
  const [debouncedTimeRange, setDebouncedTimeRange] = React.useState<TimeRange>(timeRange);

  React.useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedFilters(filters);
      setDebouncedTimeRange(timeRange);
    }, 250);
    return () => window.clearTimeout(t);
  }, [filters, timeRange]);

  const apiParams = React.useMemo(
    () => buildTraceApiParams(debouncedFilters, debouncedTimeRange),
    [debouncedFilters, debouncedTimeRange],
  );

  // SSE-only live updates — no `refetchInterval` polling. The hook below
  // returns `{status, paused, lastEventAt, reconnect}` for the Live/Pause UX.
  // If the SSE pipe is closed for too long the user sees a "Reconnecting" pill;
  // the only "fallback" is for the user to hit Refresh or wait for SSE to
  // reconnect (the hook handles exponential backoff).
  const query = useInfiniteQuery({
    queryKey: ["traces", apiParams],
    queryFn: ({ pageParam = 0 }) => listTraces({ ...(apiParams as ListTracesParams), offset: pageParam as number }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: { items: TraceRow[]; total: number }, allPages: Array<{ items: TraceRow[]; total: number }>) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  // Dedup across pages: offset-pagination against a live DB can return the
  // same id twice if a new trace inserts at the top between fetches. Without
  // this, the table would emit React `duplicate key` warnings.
  const paginated = React.useMemo(() => {
    const ids = new Set<string>();
    const out: TraceRow[] = [];
    for (const p of query.data?.pages ?? []) {
      for (const t of p.items) {
        if (ids.has(t.trace_id)) continue;
        ids.add(t.trace_id);
        out.push(t);
      }
    }
    return out;
  }, [query.data]);
  const paginatedTotal = query.data?.pages[0]?.total ?? 0;

  // SSE state — Map keyed by trace_id. SSE rows are last-write-wins over
  // paginated rows for the same id, so updated fields (status, duration_ms,
  // metadataParsed-driven name/type/model) propagate immediately.
  const [streamedRows, setStreamedRows] = React.useState<Map<string, TraceRow>>(
    () => new Map<string, TraceRow>(),
  );
  const [highlightedKeys, setHighlightedKeys] = React.useState<Set<string>>(
    () => new Set<string>(),
  );

  // Visibility-aware: only subscribe to the SSE feed while the tab is visible.
  // The real `useEventSource` hook reads `enabled` to skip subscribe work and
  // disconnect. The hook's return value drives the Live/Pause/Reconnecting
  // indicator in the table header.
  const [enabled, setEnabled] = React.useState<boolean>(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setEnabled(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const sse = useEventSource("/v1/traces/events", {
    enabled,
    onMessage: (msg) => {
      // Wire format: `data: JSON.stringify({ trace: <TraceRow> })`.
      const { trace: event } = msg.data as { trace: TraceEvent };
      const row: TraceRow = {
        trace_id: event.trace_id,
        project_id: event.project_id ?? "",
        name: event.name,
        start_time: event.start_time,
        end_time: event.end_time ?? null,
        duration_ms: event.duration_ms ?? null,
        status: event.status,
        user_id: event.user_id ?? "",
        session_id: event.session_id ?? "",
        agent_id: event.agent_id ?? "",
        agent_version: event.agent_version ?? "",
        env: event.env ?? "",
        tags: event.tags ?? [],
        input_text: event.input_text ?? "",
        output_text: event.output_text ?? "",
        scores_summary: event.scores_summary ?? "",
      };
      setStreamedRows((prev) => {
        const next = new Map(prev);
        next.set(row.trace_id, row);
        // FIFO eviction past the cap so a busy SSE stream doesn't grow the
        // map without bound. The oldest entry is dropped; the user can
        // re-fetch via filter change / window focus to recover it.
        if (next.size > STREAMED_CAP) {
          const oldest = next.keys().next().value;
          if (oldest !== undefined) next.delete(oldest);
        }
        return next;
      });
      setHighlightedKeys((prev) => {
        if (prev.has(row.trace_id)) return prev;
        const next = new Set(prev);
        next.add(row.trace_id);
        return next;
      });
    },
  });

  const merged = React.useMemo(
    () => mergeByIdDesc((t) => t.trace_id, paginated, streamedRows),
    [paginated, streamedRows],
  );

  // Total = REST-reported count + number of SSE ids that aren't already in
  // paginated. `merged.length - paginated.length` is exactly that count
  // because both layers feed `mergeByIdDesc` last-write-wins. Floor at 0
  // for the unlikely case where `merged` somehow underflows (defensive).
  const total = paginatedTotal + Math.max(0, merged.length - paginated.length);

  // FilterableTable owns the raw filter inputs (uncontrolled) and debounces
  // them. The host receives the debounced values here and feeds them into
  // `filters` / `timeRange` state so the query key changes.
  const onFiltersChange = React.useCallback(
    (next: Record<string, string>, tr: TimeRange) => {
      setFilters(next);
      setTimeRange(tr);
    },
    [],
  );

  return {
    merged,
    total,
    isLoading: query.isLoading,
    isError: (query.error as Error | null) ?? null,
    hasNextPage: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    highlightedKeys,
    filters,
    setFilters,
    timeRange,
    setTimeRange,
    onFiltersChange,
    sse,
  };
}

/** TracesTab — page-owned query + SSE merge, rendered via FilterableTable. */
export function TracesTab() {
  const navigate = useNavigate();
  const data = useTracesData();

  return (
    <FilterableTable<TraceRow>
      title="Traces"
      headerActions={<LiveTabHeader sse={data.sse} />}
      noun={{ singular: "trace", plural: "traces" }}
      emptyHint={
        <>
          No traces yet. Send one to <code>/v1/otel/v1/traces</code> to get started.
        </>
      }
      noMatchMessage="No traces match the current filters."
      columns={TRACE_COLUMNS}
      filterFields={TRACE_FILTER_FIELDS}
      items={data.merged}
      total={data.total}
      isLoading={data.isLoading}
      isError={data.isError}
      hasNextPage={data.hasNextPage}
      onLoadMore={data.fetchNextPage}
      highlightedKeys={data.highlightedKeys}
      rowKey={(t) => t.trace_id}
      onFiltersChange={data.onFiltersChange}
      onRowClick={(t) => {
        navigate({
          to: traceDetailPath(t.trace_id),
          params: { id: t.trace_id },
        });
      }}
    />
  );
}

const SPAN_COLUMNS: ColumnDef<ObservationRow>[] = [
  {
    header: "Time",
    width: "w-[180px]",
    cell: (o) => <span className="font-mono text-xs">{new Date(o.start_time).toLocaleString()}</span>,
  },
  {
    header: "Type",
    width: "w-[100px]",
    cell: (o) => (
      <Badge variant={o.type === "tool" ? "secondary" : o.type === "generation" ? "default" : "outline"}>
        {o.type}
      </Badge>
    ),
  },
  {
    header: "Name",
    width: "w-[180px]",
    cell: (o) => <span className="font-medium">{o.name}</span>,
  },
  {
    header: "Trace",
    width: "w-[160px]",
    className: "font-mono text-xs text-muted-foreground",
    cell: (o) => <span title={o.trace_id}>{o.trace_id.slice(0, 16)}…</span>,
  },
  {
    header: "Agent",
    width: "w-[160px]",
    className: "text-xs text-muted-foreground",
    cell: () => "—",
  },
  {
    header: "Status",
    width: "w-[100px]",
    cell: (o) => <Badge variant={o.status === "error" ? "destructive" : "success"}>{o.status}</Badge>,
  },
  {
    header: "Duration",
    width: "w-[110px]",
    className: "text-xs",
    cell: (o) => (o.duration_ms !== null ? `${o.duration_ms}ms` : "—"),
  },
  {
    header: "Model",
    width: "w-[160px]",
    className: "text-xs text-muted-foreground",
    cell: (o) => o.model || "—",
  },
  {
    header: "Input excerpt",
    className: "max-w-md truncate text-xs text-muted-foreground",
    cell: (o) => o.input_text || "—",
  },
];

const SPAN_FILTER_FIELDS: FilterFieldDef[] = [
  { key: "type", placeholder: "span / tool / generation", className: "font-mono" },
  { key: "name", placeholder: "e.g. llm.call" },
  { key: "trace_id", placeholder: "32-char trace id", className: "font-mono" },
  { key: "agent_id", placeholder: "e.g. code-reviewer" },
  { key: "status", placeholder: "ok / error", className: "font-mono" },
  { key: "duration", placeholder: "e.g. <500 or >1000", className: "font-mono" },
  { key: "model", placeholder: "e.g. gpt-4o", className: "font-mono" },
  { key: "input_text", placeholder: "e.g. recruiter or SQL" },
];

function buildSpanApiParams(filters: Record<string, string>, timeRange: TimeRange): ListObservationsParams {
  const out: ListObservationsParams = {};
  if (filters.type) out.type = filters.type;
  if (filters.name) out.name = filters.name;
  if (filters.trace_id) out.trace_id = filters.trace_id;
  if (filters.agent_id) out.agent_id = filters.agent_id;
  if (filters.status) out.status = filters.status;
  if (filters.duration) out.duration = filters.duration;
  if (filters.model) out.model = filters.model;
  if (filters.input_text) out.input_text = filters.input_text;
  const tr = toApiParams(timeRange);
  if (tr.time_from) out.time_from = tr.time_from;
  if (tr.time_to) out.time_to = tr.time_to;
  return out;
}

export interface ObservationEvent {
  observation_id: string;
  trace_id: string;
  project_id?: string;
  parent_observation_id?: string | null;
  type: "span" | "event" | "generation" | "tool";
  name: string;
  start_time: string;
  end_time?: string | null;
  duration_ms?: number | null;  status: "ok" | "error";
  model?: string | null;
  input_text?: string;
  output_text?: string;
  /**
   * Optional pre-parsed metadata from the SSE payload. When present, the UI
   * reads tool/model/type from it without a second fetch.
   */
  metadataParsed?: {
    tool?: { name?: string };
    model?: string;
    type?: string;
    [k: string]: unknown;
  } | null;
  metadata?: string;
}

function useSpansData() {
  const [filters, setFilters] = React.useState<Record<string, string>>(() => emptyFilters(SPAN_FILTER_FIELDS));
  const [timeRange, setTimeRange] = React.useState<TimeRange>(defaultRange());
  const [debouncedFilters, setDebouncedFilters] = React.useState<Record<string, string>>(filters);
  const [debouncedTimeRange, setDebouncedTimeRange] = React.useState<TimeRange>(timeRange);

  React.useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedFilters(filters);
      setDebouncedTimeRange(timeRange);
    }, 250);
    return () => window.clearTimeout(t);
  }, [filters, timeRange]);

  const apiParams = React.useMemo(
    () => ({ ...buildSpanApiParams(debouncedFilters, debouncedTimeRange), limit: PAGE_SIZE }),
    [debouncedFilters, debouncedTimeRange],
  );

  // SSE-only live updates — no `refetchInterval` polling. The hook returns
  // `{status, paused, lastEventAt, reconnect}` for the Live/Pause UX.
  const query = useInfiniteQuery({
    queryKey: ["observations", apiParams],
    queryFn: ({ pageParam = 0 }) => listObservations({ ...(apiParams as ListObservationsParams), offset: pageParam as number }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: { items: ObservationRow[]; total: number }, allPages: Array<{ items: ObservationRow[]; total: number }>) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  // Dedup across pages: see useTracesData. Without this, offset-pagination
  // against a live DB can produce duplicate keys in the rendered table.
  const paginated = React.useMemo(() => {
    const ids = new Set<string>();
    const out: ObservationRow[] = [];
    for (const p of query.data?.pages ?? []) {
      for (const o of p.items) {
        if (ids.has(o.observation_id)) continue;
        ids.add(o.observation_id);
        out.push(o);
      }
    }
    return out;
  }, [query.data]);
  const paginatedTotal = query.data?.pages[0]?.total ?? 0;

  // SSE state — Map keyed by observation_id. SSE rows override paginated
  // rows for the same id (last-write-wins), which is how status / duration
  // updates from a still-running trace flow into the cell content. The
  // metadataParsed override (tool.name, model, type) flows through here too.
  const [streamedRows, setStreamedRows] = React.useState<Map<string, ObservationRow>>(
    () => new Map<string, ObservationRow>(),
  );
  const [highlightedKeys, setHighlightedKeys] = React.useState<Set<string>>(
    () => new Set<string>(),
  );

  const [enabled, setEnabled] = React.useState<boolean>(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setEnabled(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const sse = useEventSource("/v1/observations/events", {
    enabled,
    onMessage: (msg) => {
      // Wire format: `data: JSON.stringify({ observation: <ObservationRow>, metadataParsed })`.
      // The detail-page hook (`useTraceStream`) reads the same wrapped shape.
      const { observation: event, metadataParsed } = msg.data as {
        observation: ObservationEvent;
        metadataParsed: ObservationEvent["metadataParsed"];
      };
      const md = metadataParsed ?? null;
      const row: ObservationRow = {
        observation_id: event.observation_id,
        trace_id: event.trace_id,
        project_id: event.project_id ?? "",
        parent_observation_id: event.parent_observation_id ?? null,
        type: (md?.type as ObservationRow["type"]) ?? event.type,
        name: md?.tool?.name ?? event.name,
        start_time: event.start_time,
        end_time: event.end_time ?? null,
        duration_ms: event.duration_ms ?? null,
        status: event.status,
        model: md?.model ?? event.model ?? null,
        input_text: event.input_text ?? "",
        output_text: event.output_text ?? "",
        metadata: event.metadata ?? JSON.stringify(md ?? {}),
      };
      setStreamedRows((prev) => {
        const next = new Map(prev);
        next.set(row.observation_id, row);
        if (next.size > STREAMED_CAP) {
          const oldest = next.keys().next().value;
          if (oldest !== undefined) next.delete(oldest);
        }
        return next;
      });
      setHighlightedKeys((prev) => {
        if (prev.has(row.observation_id)) return prev;
        const next = new Set(prev);
        next.add(row.observation_id);
        return next;
      });
    },
  });

  const merged = React.useMemo(
    () => mergeByIdDesc((o) => o.observation_id, paginated, streamedRows),
    [paginated, streamedRows],
  );

  // Total = REST-reported count + number of SSE ids that aren't already in
  // paginated. See useTracesData for why this is exactly
  // `merged.length - paginated.length` (and floored at 0 defensively).
  const total = paginatedTotal + Math.max(0, merged.length - paginated.length);

  // FilterableTable owns the raw filter inputs (uncontrolled) and debounces
  // them. The host receives the debounced values here and feeds them into
  // `filters` / `timeRange` state so the query key changes.
  const onFiltersChange = React.useCallback(
    (next: Record<string, string>, tr: TimeRange) => {
      setFilters(next);
      setTimeRange(tr);
    },
    [],
  );

  return {
    merged,
    total,
    isLoading: query.isLoading,
    isError: (query.error as Error | null) ?? null,
    hasNextPage: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    highlightedKeys,
    filters,
    setFilters,
    timeRange,
    setTimeRange,
    onFiltersChange,
    sse,
  };
}

/** SpansTab — page-owned query + SSE merge, rendered via FilterableTable. */
export function SpansTab() {
  const navigate = useNavigate();
  const data = useSpansData();

  return (
    <FilterableTable<ObservationRow>
      title="Spans"
      headerActions={<LiveTabHeader sse={data.sse} />}
      noun={{ singular: "span", plural: "spans" }}
      emptyHint={
        <>
          No spans yet. Send one to <code>/v1/otel/v1/traces</code> to get started.
        </>
      }
      noMatchMessage="No spans match the current filters."
      columns={SPAN_COLUMNS}
      filterFields={SPAN_FILTER_FIELDS}
      items={data.merged}
      total={data.total}
      isLoading={data.isLoading}
      isError={data.isError}
      hasNextPage={data.hasNextPage}
      onLoadMore={data.fetchNextPage}
      highlightedKeys={data.highlightedKeys}
      rowKey={(o) => o.observation_id}
      onFiltersChange={data.onFiltersChange}
      onRowClick={(o) => {
        navigate({
          to: traceDetailPath(o.trace_id),
          params: { id: o.trace_id },
          search: { span: o.observation_id },
        });
      }}
    />
  );
}

function emptyFilters(fields: FilterFieldDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.key] = "";
  return out;
}

/**
 * Path helper for the trace detail route. The new route is registered
 * under `/observability/traces/$id`; this helper keeps the row-click
 * navigation target in one place so the list pages stay consistent.
 */
function traceDetailPath(traceId: string): string {
  return `/observability/traces/${encodeURIComponent(traceId)}`;
}
