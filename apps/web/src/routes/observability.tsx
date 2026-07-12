import * as React from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LuActivity, LuListTree } from "react-icons/lu";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  FilterableTable,
  type ColumnDef,
  type FilterFieldDef,
} from "../components/FilterableTable";
import { Badge } from "../components/ui/badge";
import {
  listTraces,
  listObservations,
  type ListTracesParams,
  type ListObservationsParams,
  type TraceRow,
  type ObservationRow,
} from "../lib/api";
import { defaultRange, toApiParams, type TimeRange } from "../components/TimeRangePicker";
import { useEventSource } from "../hooks/useEventSource";
type Tab = "traces" | "spans";

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

function dedupByKey<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = keyOf(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/**
 * Append-only SSE items buffer with a `requestAnimationFrame`-style coalesce:
 * we flush the buffer into React state at most once per `minIntervalMs` (the
 * slice 4 real hook will use `requestAnimationFrame` directly; this version
 * uses `setTimeout` for the stub so jsdom's fake timers behave deterministically).
 */
function useCoalescedStream<T>(minIntervalMs = 100) {
  const [items, setItems] = React.useState<T[]>([]);
  const bufferRef = React.useRef<T[]>([]);
  const timerRef = React.useRef<number | null>(null);

  const flush = React.useCallback(() => {
    if (bufferRef.current.length === 0) return;
    const drained = bufferRef.current;
    bufferRef.current = [];
    setItems((prev) => [...prev, ...drained]);
  }, []);

  const push = React.useCallback(
    (incoming: T[]) => {
      if (incoming.length === 0) return;
      for (const i of incoming) bufferRef.current.push(i);
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        flush();
      }, minIntervalMs);
    },
    [flush, minIntervalMs],
  );

  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const reset = React.useCallback(() => {
    bufferRef.current = [];
    setItems([]);
  }, []);

  return { items, push, reset };
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
    () => ({ ...buildTraceApiParams(debouncedFilters, debouncedTimeRange), limit: PAGE_SIZE }),
    [debouncedFilters, debouncedTimeRange],
  );

  const query = useInfiniteQuery({
    queryKey: ["traces", apiParams],
    queryFn: ({ pageParam = 0 }) => listTraces({ ...(apiParams as ListTracesParams), offset: pageParam as number }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: { items: TraceRow[]; total: number }, allPages: Array<{ items: TraceRow[]; total: number }>) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    refetchInterval: 10_000,
  });

  const paginated = React.useMemo(
    () => (query.data?.pages.flatMap((p) => p.items) ?? []) as TraceRow[],
    [query.data],
  );
  const paginatedTotal = query.data?.pages[0]?.total ?? 0;

  const [streamed, setStreamed] = React.useState<TraceRow[]>([]);
  const stream = useCoalescedStream<TraceRow>(100);
  // Mirror the coalesced-stream items into `streamed` so the merged render
  // sees them. The coalesced buffer smooths bursts at the cost of one frame
  // of latency, which is fine for a live list.
  React.useEffect(() => {
    if (stream.items.length === 0) return;
    setStreamed((prev) => dedupByKey([...prev, ...stream.items], (t) => t.trace_id));
    stream.reset();
  }, [stream.items, stream]);
  const [highlightedKeys, setHighlightedKeys] = React.useState<Set<string>>(new Set());

  // Visibility-aware: only subscribe to the SSE feed while the tab is visible.
  // The stub for `useEventSource` returns closed unconditionally; the real
  // hook (slice 4) reads `enabled` to skip subscribe work and disconnect.
  const [enabled, setEnabled] = React.useState<boolean>(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setEnabled(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEventSource("/v1/traces/events", {
    enabled,
    onMessage: (msg) => {
      const event = msg.data as TraceEvent;
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
      stream.push([row]);
      setHighlightedKeys((prev) => {
        if (prev.has(row.trace_id)) return prev;
        const next = new Set(prev);
        next.add(row.trace_id);
        return next;
      });
    },
  });

  const merged = React.useMemo(
    () => dedupByKey([...paginated, ...streamed], (t) => t.trace_id),
    [paginated, streamed],
  );

  const total = paginatedTotal + streamed.length;

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
  };
}

/** TracesTab — page-owned query + SSE merge, rendered via FilterableTable. */
export function TracesTab() {
  const navigate = useNavigate();
  const data = useTracesData();

  return (
    <FilterableTable<TraceRow>
      title="Traces"
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
        } as never);
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

  const query = useInfiniteQuery({
    queryKey: ["observations", apiParams],
    queryFn: ({ pageParam = 0 }) => listObservations({ ...(apiParams as ListObservationsParams), offset: pageParam as number }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: { items: ObservationRow[]; total: number }, allPages: Array<{ items: ObservationRow[]; total: number }>) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    refetchInterval: 10_000,
  });

  const paginated = React.useMemo(
    () => (query.data?.pages.flatMap((p) => p.items) ?? []) as ObservationRow[],
    [query.data],
  );
  const paginatedTotal = query.data?.pages[0]?.total ?? 0;

  const [streamed, setStreamed] = React.useState<ObservationRow[]>([]);
  const stream = useCoalescedStream<ObservationRow>(100);
  React.useEffect(() => {
    if (stream.items.length === 0) return;
    setStreamed((prev) => dedupByKey([...prev, ...stream.items], (o) => o.observation_id));
    stream.reset();
  }, [stream.items, stream]);
  const [highlightedKeys, setHighlightedKeys] = React.useState<Set<string>>(new Set());

  const [enabled, setEnabled] = React.useState<boolean>(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setEnabled(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEventSource("/v1/observations/events", {
    enabled,
    onMessage: (msg) => {
      const event = msg.data as ObservationEvent;
      const md = event.metadataParsed ?? null;
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
      stream.push([row]);
      setHighlightedKeys((prev) => {
        if (prev.has(row.observation_id)) return prev;
        const next = new Set(prev);
        next.add(row.observation_id);
        return next;
      });
    },
  });

  const merged = React.useMemo(
    () => dedupByKey([...paginated, ...streamed], (o) => o.observation_id),
    [paginated, streamed],
  );

  const total = paginatedTotal + streamed.length;

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
  };
}

/** SpansTab — page-owned query + SSE merge, rendered via FilterableTable. */
export function SpansTab() {
  const navigate = useNavigate();
  const data = useSpansData();

  return (
    <FilterableTable<ObservationRow>
      title="Spans"
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
        } as never);
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
 * Forward-compatible target route for the trace detail page. Slice 5 (route
 * restructure) will register `/observability/traces/$id`; until then the
 * router still serves `/traces/$id`. Tests assert the captured navigate
 * target string, which is independent of whether the route is currently
 * registered.
 */
function traceDetailPath(traceId: string): string {
  return `/observability/traces/${encodeURIComponent(traceId)}`;
}
