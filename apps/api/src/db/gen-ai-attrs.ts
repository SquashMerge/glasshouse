// Normalize OTLP span attributes into our internal Trace / Observation shape.
// Extracts gen_ai.* (OpenTelemetry GenAI semantic conventions) and falls back
// to OpenInference (Arize Phoenix) attributes when gen_ai.* is absent.

import type { Span } from "../schemas/otlp.js";

type Attribute = { key: string; value: { stringValue?: string; intValue?: number | string; boolValue?: boolean; doubleValue?: number } };

function attrString(attrs: Attribute[], key: string): string | undefined {
  const a = attrs.find((x) => x.key === key);
  if (!a) return undefined;
  const v = a.value;
  return v?.stringValue;
}

function attrNumber(attrs: Attribute[], key: string): number | undefined {
  const a = attrs.find((x) => x.key === key);
  if (!a) return undefined;
  const v = a.value;
  if (typeof v?.intValue === "number") return v.intValue;
  if (typeof v?.intValue === "string") return Number(v.intValue);
  if (typeof v?.doubleValue === "number") return v.doubleValue;
  return undefined;
}

// Normalized span (matches the existing apps/api/src/schemas/traces.ts Trace +
// Observation shape).
export interface NormalizedTrace {
  trace_id: string;
  name: string;
  start_time: string;       // ISO datetime
  end_time: string | null;  // ISO datetime or null for in-flight spans
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
  scores_summary: string;   // CSV of name:value pairs
}

export interface NormalizedObservation {
  observation_id: string;
  trace_id: string;
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
  metadata: string;          // JSON-serialized
}

function isoFromUnixNano(nano: number): string {
  // OTLP timestamps are in nanoseconds since epoch; JS Date uses ms.
  return new Date(Math.floor(nano / 1_000_000)).toISOString();
}

function durationMs(startNano: number | undefined, endNano: number | undefined): number | null {
  if (startNano === undefined || endNano === undefined) return null;
  return Math.max(0, Math.floor((endNano - startNano) / 1_000_000));
}

function scorePairsAsCsv(pairs: Array<[string, number]>): string {
  return pairs.map(([k, v]) => `${k}:${v}`).join(",");
}

export function normalizeSpan(span: Span): { trace: NormalizedTrace; observation: NormalizedObservation } {
  const attrs = (span.attributes ?? []) as Attribute[];

  // gen_ai.* first (R2: precedence over OpenInference).
  // OpenInference fallback.
  const agentId =
    attrString(attrs, "gen_ai.agent.id") ??
    attrString(attrs, "agent.id") ??
    "";
  const agentVersion =
    attrString(attrs, "gen_ai.agent.version") ??
    attrString(attrs, "agent.version") ??
    "";
  const env =
    attrString(attrs, "deployment.environment") ??
    attrString(attrs, "gen_ai.environment") ??
    attrString(attrs, "env") ??
    "production";
  const userId =
    attrString(attrs, "enduser.id") ??
    attrString(attrs, "user.id") ??
    "";
  const sessionId =
    attrString(attrs, "session.id") ??
    "";

  const model =
    attrString(attrs, "gen_ai.response.model") ??
    attrString(attrs, "gen_ai.request.model") ??
    attrString(attrs, "llm.model_name") ??
    "";

  const inputText =
    attrString(attrs, "gen_ai.prompt.0.content") ??
    attrString(attrs, "input.value") ??
    "";
  const outputText =
    attrString(attrs, "gen_ai.completion.0.content") ??
    attrString(attrs, "output.value") ??
    "";

  // Scores summary: token usage + response finish reason.
  const scorePairs: Array<[string, number]> = [];
  const inTok = attrNumber(attrs, "gen_ai.usage.input_tokens") ?? attrNumber(attrs, "llm.token_count.prompt");
  const outTok = attrNumber(attrs, "gen_ai.usage.output_tokens") ?? attrNumber(attrs, "llm.token_count.completion");
  if (inTok !== undefined) scorePairs.push(["input_tokens", inTok]);
  if (outTok !== undefined) scorePairs.push(["output_tokens", outTok]);
  const scoresCsv = scorePairsAsCsv(scorePairs);

  // Span status.
  let status: "ok" | "error" = "ok";
  if (span.status?.code === 2) status = "error";
  // OpenInference exception marker.
  const exc = attrs.find((a) => a.key === "exception.type");
  if (exc) status = "error";

  // Tags: span kind + OpenInference span kind.
  const tags: string[] = [];
  if (span.kind !== undefined) tags.push(`span.kind:${span.kind}`);
  const oiKind = attrString(attrs, "openinference.span.kind");
  if (oiKind) tags.push(`openinference.span.kind:${oiKind}`);

  const trace: NormalizedTrace = {
    trace_id: span.trace_id,
    name: span.name,
    start_time: isoFromUnixNano(span.start_time_unix_nano as unknown as number),
    end_time: span.end_time_unix_nano !== undefined ? isoFromUnixNano(span.end_time_unix_nano as unknown as number) : null,
    duration_ms: durationMs(span.start_time_unix_nano as unknown as number, span.end_time_unix_nano as unknown as number),
    status,
    user_id: userId,
    session_id: sessionId,
    agent_id: agentId,
    agent_version: agentVersion,
    env,
    tags,
    input_text: inputText,
    output_text: outputText,
    scores_summary: scoresCsv,
  };

  const observation: NormalizedObservation = {
    observation_id: span.span_id,
    trace_id: span.trace_id,
    parent_observation_id: span.parent_span_id ?? null,
    type: "span",
    name: span.name,
    start_time: trace.start_time,
    end_time: trace.end_time,
    duration_ms: trace.duration_ms,
    status,
    model: model || null,
    input_text: inputText,
    output_text: outputText,
    metadata: JSON.stringify(span.attributes ?? []),
  };

  return { trace, observation };
}