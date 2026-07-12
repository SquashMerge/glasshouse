import { authedFetch } from "./auth";

export interface TraceRow {
  trace_id: string;
  project_id: string;
  name: string;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  status: "ok" | "error";
  user_id: string;
  session_id: string;
  agent_id: string;
  agent_version: string;
  env: string;
  tags: string[];
  input_text: string;
  output_text: string;
  scores_summary: string;
}

export interface ObservationRow {
  observation_id: string;
  trace_id: string;
  project_id: string;
  parent_observation_id: string | null;
  type: "span" | "event" | "generation" | "tool";
  name: string;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  status: "ok" | "error";
  model: string | null;
  input_text: string;
  output_text: string;
  metadata: string;
}

export interface TraceListResponse {
  items: TraceRow[];
  total: number;
}

export interface TraceDetailResponse {
  trace: TraceRow;
  observations: ObservationRow[];
}

function buildQs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface ListTracesParams {
  limit?: number;
  offset?: number;
  env?: string;
  agent_id?: string;
  name?: string;
  status?: string;
  duration?: string;
  scores?: string;
  input_text?: string;
  time_from?: string;
  time_to?: string;
}

export async function listTraces(params: ListTracesParams = {}): Promise<TraceListResponse> {
  const qs = buildQs({
    limit: params.limit,
    offset: params.offset,
    "filter[env]": params.env,
    "filter[agent_id]": params.agent_id,
    "filter[name]": params.name,
    "filter[status]": params.status,
    "filter[duration]": params.duration,
    "filter[scores]": params.scores,
    "filter[input_text]": params.input_text,
    "filter[time.from]": params.time_from,
    "filter[time.to]": params.time_to,
  });
  const res = await authedFetch(`/v1/traces${qs}`);
  if (!res.ok) throw new Error(`listTraces ${res.status}`);
  return res.json();
}

export async function getTrace(traceId: string): Promise<TraceDetailResponse> {
  const res = await authedFetch(`/v1/traces/${encodeURIComponent(traceId)}`);
  if (res.status === 404) throw new Error("not_found");
  if (!res.ok) throw new Error(`getTrace ${res.status}`);
  return res.json();
}

export async function searchTraces(params: {
  q?: string;
  env?: string;
  agent_id?: string;
  time_from?: string;
  time_to?: string;
  sort?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<TraceListResponse> {
  const qs = buildQs({
    q: params.q,
    "filter[env]": params.env,
    "filter[agent_id]": params.agent_id,
    "filter[time.from]": params.time_from,
    "filter[time.to]": params.time_to,
    sort: params.sort,
    limit: params.limit,
    offset: params.offset,
  });
  const res = await authedFetch(`/v1/traces/search${qs}`);
  if (!res.ok) throw new Error(`searchTraces ${res.status}`);
  return res.json();
}