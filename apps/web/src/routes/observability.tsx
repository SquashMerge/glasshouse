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
 * Hook that owns the data fetch for TracesTab. Exposed so the test file can
 * import it (and so we keep `TracesTab` small).
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

  const paginated = React.useMemo(
    () => (query.data?.pages.flatMap((p) => p.items) ?? []) as TraceRow[],
    [query.data],
  );
  const paginatedTotal = query.data?.pages[0]?.total ?? 0;

  // Set of ids currently in the loaded page. Used to decide whether a
  // streamed event is an "in-view" insertion (highlight in place) or an
  // "out-of-view" arrival (just bump the total counter — no table re-render).
  // Memoized so the Set is rebuilt only when `paginated` changes.
  const paginatedIds = React.useMemo(() => {
    const s = new Set<string>();
    for (const t of paginated) s.add(t.trace_id);
    return s;
  }, [paginated]);

  const [highlightedKeys, setHighlightedKeys] = React.useState<Set<string>>(
    () => new Set<string>(),
  );
  const [extraStreamedCount, setExtraStreamedCount] = React.useState(0);

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
      const id = event.trace_id;
      if (paginatedIds.has(id)) {
        // In-view: flag for a 1.5s highlight. The HighlightedRow component
        // owns its own setTimeout so the visual fades; we just track ids.
        // No table mutation — `merged = paginated`, and the row is already
        // there.
        setHighlightedKeys((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      } else {
        // Out-of-view: bump total. Don't touch the rendered list — the
        // user will see the bumped counter and can scroll / load more to
        // surface the row.
        setExtraStreamedCount((c) => c + 1);
      }
    },
  });

  // Merged is just the paginated view. SSE items either highlight in place
  // (in-view) or just bump the counter (out-of-view). Keeps the rendered
  // table bounded to the current page size regardless of SSE rate.
  const merged = paginated;
  const total = paginatedTotal + extraStreamedCount;

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

  const paginated = React.useMemo(
    () => (query.data?.pages.flatMap((p) => p.items) ?? []) as ObservationRow[],
    [query.data],
  );
  const paginatedTotal = query.data?.pages[0]?.total ?? 0;

  // Set of ids currently in the loaded page. See useTracesData for the
  // full in-view / out-of-view rationale.
  const paginatedIds = React.useMemo(() => {
    const s = new Set<string>();
    for (const o of paginated) s.add(o.observation_id);
    return s;
  }, [paginated]);

  const [highlightedKeys, setHighlightedKeys] = React.useState<Set<string>>(
    () => new Set<string>(),
  );
  const [extraStreamedCount, setExtraStreamedCount] = React.useState(0);

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
      // We only need the id for routing — `merged = paginated`, so when the
      // id matches, the row is already in the table. HighlightedRow owns the
      // 1.5s visual setTimeout locally.
      const id = (msg.data as { observation: { observation_id: string } }).observation.observation_id;
      if (paginatedIds.has(id)) {
        setHighlightedKeys((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      } else {
        setExtraStreamedCount((c) => c + 1);
      }
    },
  });

  const merged = paginated;
  const total = paginatedTotal + extraStreamedCount;

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
