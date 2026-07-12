import * as React from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";
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

      {tab === "traces" ? <TracesTab onTabChange={setTab} /> : <SpansTab onTabChange={setTab} />}
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

function TracesTab({ onTabChange: _onTabChange }: { onTabChange: (t: Tab) => void }) {
  const navigate = useNavigate();
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
      queryKey="traces"
      buildApiParams={buildTraceApiParams}
      queryFn={async (p) => listTraces(p as ListTracesParams & { offset: number })}
      rowKey={(t) => t.trace_id}
      onRowClick={(t) => navigate({ to: "/traces/$id", params: { id: t.trace_id } })}
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

function SpansTab({ onTabChange: _onTabChange }: { onTabChange: (t: Tab) => void }) {
  const navigate = useNavigate();
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
      queryKey="observations"
      buildApiParams={buildSpanApiParams}
      queryFn={async (p) => listObservations(p as ListObservationsParams & { offset: number })}
      rowKey={(o) => o.observation_id}
      onRowClick={(o) => navigate({ to: "/traces/$id", params: { id: o.trace_id } })}
    />
  );
}

void defaultRange;