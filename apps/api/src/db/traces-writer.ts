import type { ClickHouseClient } from "@clickhouse/client";
import { ch } from "./clickhouse.js";
import type { NormalizedObservation, NormalizedTrace } from "./gen-ai-attrs.js";

interface ClickHouseRow {
  [key: string]: string | number | null | string[];
}

function traceToRow(t: NormalizedTrace): ClickHouseRow {
  return {
    trace_id: t.trace_id,
    project_id: "",                // populated from auth context (single-tenant for now)
    name: t.name,
    start_time: t.start_time,
    end_time: t.end_time,
    duration_ms: t.duration_ms,
    status: t.status,
    user_id: t.user_id,
    session_id: t.session_id,
    agent_id: t.agent_id,
    agent_version: t.agent_version,
    env: t.env,
    tags: t.tags,
    input_text: t.input_text,
    output_text: t.output_text,
    scores_summary: t.scores_summary,
    metadata: "",
  };
}

function observationToRow(o: NormalizedObservation): ClickHouseRow {
  return {
    observation_id: o.observation_id,
    trace_id: o.trace_id,
    project_id: "",
    parent_observation_id: o.parent_observation_id,
    type: o.type,
    name: o.name,
    start_time: o.start_time,
    end_time: o.end_time,
    duration_ms: o.duration_ms,
    status: o.status,
    model: o.model,
    input_text: o.input_text,
    output_text: o.output_text,
    metadata: o.metadata,
  };
}

export async function insertTraces(client: ClickHouseClient, traces: NormalizedTrace[]): Promise<void> {
  if (traces.length === 0) return;
  await client.insert({
    table: "traces",
    values: traces.map(traceToRow),
    format: "JSONEachRow",
  });
}

export async function insertObservations(client: ClickHouseClient, observations: NormalizedObservation[]): Promise<void> {
  if (observations.length === 0) return;
  await client.insert({
    table: "observations",
    values: observations.map(observationToRow),
    format: "JSONEachRow",
  });
}

export function defaultClient(): ClickHouseClient {
  return ch();
}