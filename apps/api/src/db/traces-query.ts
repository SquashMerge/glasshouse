import type { ClickHouseClient } from "@clickhouse/client";
import { ch } from "./clickhouse.js";

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

export interface TraceListFilters {
  project_id?: string;
  agent_id?: string;
  env?: string;
  time_from?: string;   // ISO datetime
  time_to?: string;
}

export interface TraceSearchQuery extends TraceListFilters {
  q?: string;
  sort?: string;        // "start_time:desc" | "start_time:asc" | "duration_ms:desc" | ...
  expand?: string;      // comma-separated, currently unused (deferred)
}

const LIST_COLUMNS =
  "trace_id, project_id, name, start_time, end_time, duration_ms, status, user_id, session_id, agent_id, agent_version, env, tags, substring(input_text, 1, 200) AS input_text, output_text, scores_summary";

const OBSERVATION_COLUMNS =
  "observation_id, trace_id, project_id, parent_observation_id, type, name, start_time, end_time, duration_ms, status, model, input_text, output_text, metadata";

function defaultClient(): ClickHouseClient {
  return ch();
}

export async function listTraces(
  client: ClickHouseClient,
  filters: TraceListFilters,
  limit: number,
  offset: number,
): Promise<{ items: TraceRow[]; total: number }> {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit, offset };
  if (filters.project_id) {
    where.push("project_id = {project_id: String}");
    params.project_id = filters.project_id;
  }
  if (filters.agent_id) {
    where.push("agent_id = {agent_id: String}");
    params.agent_id = filters.agent_id;
  }
  if (filters.env) {
    where.push("env = {env: String}");
    params.env = filters.env;
  }
  if (filters.time_from) {
    where.push("start_time >= {time_from: DateTime64(3)}");
    params.time_from = filters.time_from;
  }
  if (filters.time_to) {
    where.push("start_time <= {time_to: DateTime64(3)}");
    params.time_to = filters.time_to;
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const itemsResult = await client.query({
    query: `SELECT ${LIST_COLUMNS} FROM traces ${whereClause} ORDER BY start_time DESC LIMIT {limit: Int32} OFFSET {offset: Int32}`,
    query_params: params,
    format: "JSONEachRow",
  });
  const items = (await itemsResult.json()) as TraceRow[];

  const totalResult = await client.query({
    query: `SELECT count() AS total FROM traces ${whereClause}`,
    query_params: params,
    format: "JSONEachRow",
  });
  const totalRows = (await totalResult.json()) as Array<{ total: string | number }>;
  const total = totalRows.length > 0 ? Number(totalRows[0].total) : 0;

  return { items, total };
}

export async function getTrace(client: ClickHouseClient, traceId: string): Promise<{ trace: TraceRow | null; observations: ObservationRow[] }> {
  const traceResult = await client.query({
    query: `SELECT ${LIST_COLUMNS} FROM traces WHERE trace_id = {trace_id: String} LIMIT 1`,
    query_params: { trace_id: traceId },
    format: "JSONEachRow",
  });
  const traceRows = (await traceResult.json()) as TraceRow[];
  const trace = traceRows.length > 0 ? traceRows[0] : null;
  if (!trace) return { trace: null, observations: [] };

  const obsResult = await client.query({
    query: `SELECT ${OBSERVATION_COLUMNS} FROM observations WHERE trace_id = {trace_id: String} ORDER BY start_time ASC`,
    query_params: { trace_id: traceId },
    format: "JSONEachRow",
  });
  const observations = (await obsResult.json()) as ObservationRow[];

  return { trace, observations };
}

export async function searchTraces(
  client: ClickHouseClient,
  query: TraceSearchQuery,
  limit: number,
  offset: number,
): Promise<{ items: TraceRow[]; total: number }> {
  // For full-text, use positionCaseInsensitiveUTF8 against input_text + output_text.
  // tokenbf_v1 indexes (set up in infra/db/clickhouse/0001_traces.sql) accelerate this.
  const filters: TraceListFilters = query;
  const where: string[] = [];
  const params: Record<string, unknown> = { limit, offset };
  if (query.q && query.q.length > 0) {
    where.push("(positionCaseInsensitiveUTF8(input_text, {q: String}) > 0 OR positionCaseInsensitiveUTF8(output_text, {q: String}) > 0)");
    params.q = query.q;
  }
  if (filters.project_id) {
    where.push("project_id = {project_id: String}");
    params.project_id = filters.project_id;
  }
  if (filters.agent_id) {
    where.push("agent_id = {agent_id: String}");
    params.agent_id = filters.agent_id;
  }
  if (filters.env) {
    where.push("env = {env: String}");
    params.env = filters.env;
  }
  if (filters.time_from) {
    where.push("start_time >= {time_from: DateTime64(3)}");
    params.time_from = filters.time_from;
  }
  if (filters.time_to) {
    where.push("start_time <= {time_to: DateTime64(3)}");
    params.time_to = filters.time_to;
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  // Sort: defaults to start_time:desc.
  let orderBy = "ORDER BY start_time DESC";
  if (query.sort === "start_time:asc") orderBy = "ORDER BY start_time ASC";
  else if (query.sort === "duration_ms:desc") orderBy = "ORDER BY duration_ms DESC";
  else if (query.sort === "duration_ms:asc") orderBy = "ORDER BY duration_ms ASC";

  const itemsResult = await client.query({
    query: `SELECT ${LIST_COLUMNS} FROM traces ${whereClause} ${orderBy} LIMIT {limit: Int32} OFFSET {offset: Int32}`,
    query_params: params,
    format: "JSONEachRow",
  });
  const items = (await itemsResult.json()) as TraceRow[];

  const totalResult = await client.query({
    query: `SELECT count() AS total FROM traces ${whereClause}`,
    query_params: params,
    format: "JSONEachRow",
  });
  const totalRows = (await totalResult.json()) as Array<{ total: string | number }>;
  const total = totalRows.length > 0 ? Number(totalRows[0].total) : 0;

  return { items, total };
}

export { defaultClient };