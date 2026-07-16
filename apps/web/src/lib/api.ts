import { authedFetch } from "./auth";

export type JsonObject = Record<string, unknown>;

export interface ApiErrorEnvelope {
  code: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function responseJson<T>(response: Response, operation: string): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;

  let envelope: ApiErrorEnvelope | null = null;
  try {
    envelope = await response.json() as ApiErrorEnvelope;
  } catch {
    envelope = null;
  }
  throw new ApiError(
    response.status,
    envelope?.code ?? "REQUEST_FAILED",
    envelope?.message ?? `${operation} ${response.status}`,
  );
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface ProjectListResponse {
  items: Project[];
  total: number;
}

export async function listProjects(): Promise<ProjectListResponse> {
  return responseJson<ProjectListResponse>(await authedFetch("/v1/projects"), "listProjects");
}

export type PromptRole = "system" | "user";

export interface PromptMessage {
  role: PromptRole;
  content: string;
}

export interface PromptVersion {
  id: string;
  version: number;
  messages: PromptMessage[];
  model: string | null;
  settings: JsonObject;
  change_summary: string;
  created_by: string;
  created_at: string;
  content_hash: string;
  diff: string | null;
}

export interface Prompt extends PromptVersion {
  project_id: string;
  name: string;
  description: string | null;
}

export interface PromptListResponse {
  items: Prompt[];
  total: number;
}

export interface PromptVersionListResponse {
  items: PromptVersion[];
}

export interface CreatePromptInput {
  project_id: string;
  name: string;
  description?: string | null;
  messages: PromptMessage[];
  model?: string | null;
  settings?: JsonObject;
}

export interface CreatePromptVersionInput {
  project_id: string;
  slug: string;
  base_version: number;
  messages: PromptMessage[];
  model?: string | null;
  settings?: JsonObject;
  change_summary: string;
}

export interface RenderPromptInput {
  project_id: string;
  slug: string;
  version?: number;
  data: JsonObject;
}

export interface PromptRenderResponse {
  id: string;
  version: number;
  content_hash: string;
  messages: PromptMessage[];
  warnings: Array<{ code: "MISSING_VARIABLE"; role: PromptRole; path: string }>;
}

export interface PromptPreviewResponse {
  messages: PromptMessage[];
  warnings: Array<{ code: "MISSING_VARIABLE"; role: PromptRole; path: string }>;
}

export interface PromptProvenanceStatusResponse {
  status: "active" | "deleted" | "unknown";
}

export async function listPrompts(projectId: string): Promise<PromptListResponse> {
  return responseJson<PromptListResponse>(
    await authedFetch(`/v1/prompts${buildQs({ project_id: projectId })}`),
    "listPrompts",
  );
}

export async function createPrompt(input: CreatePromptInput): Promise<Prompt> {
  return responseJson<Prompt>(await authedFetch("/v1/prompts", jsonRequest(input)), "createPrompt");
}

export async function getPrompt(input: { project_id: string; slug: string; version?: number }): Promise<Prompt> {
  return responseJson<Prompt>(
    await authedFetch(`/v1/prompts/${encodeURIComponent(input.slug)}${buildQs({ project_id: input.project_id, version: input.version })}`),
    "getPrompt",
  );
}

export async function listPromptVersions(input: { project_id: string; slug: string }): Promise<PromptVersionListResponse> {
  return responseJson<PromptVersionListResponse>(
    await authedFetch(`/v1/prompts/${encodeURIComponent(input.slug)}/versions${buildQs({ project_id: input.project_id })}`),
    "listPromptVersions",
  );
}

export async function createPromptVersion(input: CreatePromptVersionInput): Promise<PromptVersion> {
  const { project_id, slug, ...body } = input;
  return responseJson<PromptVersion>(
    await authedFetch(
      `/v1/prompts/${encodeURIComponent(slug)}/versions${buildQs({ project_id })}`,
      jsonRequest(body),
    ),
    "createPromptVersion",
  );
}

export async function renderPrompt(input: RenderPromptInput): Promise<PromptRenderResponse> {
  const { project_id, slug, version, data } = input;
  return responseJson<PromptRenderResponse>(
    await authedFetch(
      `/v1/prompts/${encodeURIComponent(slug)}/render${buildQs({ project_id, version })}`,
      jsonRequest({ data }),
    ),
    "renderPrompt",
  );
}

export async function previewPrompt(input: { messages: PromptMessage[]; data: JsonObject }): Promise<PromptPreviewResponse> {
  return responseJson<PromptPreviewResponse>(await authedFetch("/v1/prompts/preview", jsonRequest(input)), "previewPrompt");
}

export async function deletePrompt(input: { project_id: string; slug: string; confirmation: string }): Promise<void> {
  const { project_id, slug, confirmation } = input;
  const response = await authedFetch(
    `/v1/prompts/${encodeURIComponent(slug)}${buildQs({ project_id })}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    },
  );
  if (!response.ok) await responseJson<never>(response, "deletePrompt");
}

export async function getPromptProvenance(input: {
  project_id: string;
  id: string;
  version: number;
  content_hash: string;
}): Promise<PromptProvenanceStatusResponse> {
  const { id, ...query } = input;
  return responseJson<PromptProvenanceStatusResponse>(
    await authedFetch(`/v1/prompt-provenance/${encodeURIComponent(id)}${buildQs(query)}`),
    "getPromptProvenance",
  );
}

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

export interface OtlpAttribute {
  key: string;
  value?: Record<string, unknown> | unknown[];
}

export interface PromptProvenance {
  id: string;
  version: number;
  content_hash: string;
}

export interface ObservationMetadata {
  schema_version: 1;
  attributes: OtlpAttribute[];
  prompt_provenance: PromptProvenance | null;
}

export type ObservationMetadataInput = ObservationMetadata | string | null | undefined;

const PROMPT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function emptyObservationMetadata(): ObservationMetadata {
  return { schema_version: 1, attributes: [], prompt_provenance: null };
}

export function normalizeObservationMetadata(
  raw: ObservationMetadataInput,
  isGeneration = true,
): ObservationMetadata {
  const parsed = typeof raw === "string" ? parseMetadataString(raw) : raw;
  if (Array.isArray(parsed)) {
    return isAttributeArray(parsed)
      ? { schema_version: 1, attributes: sanitizeMetadataAttributes(parsed), prompt_provenance: null }
      : emptyObservationMetadata();
  }
  if (!isMetadataEnvelope(parsed)) return emptyObservationMetadata();
  return {
    schema_version: 1,
    attributes: sanitizeMetadataAttributes(parsed.attributes),
    prompt_provenance: isGeneration && isPromptProvenance(parsed.prompt_provenance)
      ? parsed.prompt_provenance
      : null,
  };
}

function parseMetadataString(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOtlpAttribute(value: unknown): value is OtlpAttribute {
  return isRecord(value) && typeof value.key === "string" &&
    (value.value === undefined || isRecord(value.value) || Array.isArray(value.value));
}

function isAttributeArray(value: unknown): value is OtlpAttribute[] {
  return Array.isArray(value) && value.every(isOtlpAttribute);
}

function isPromptProvenance(value: unknown): value is PromptProvenance {
  return isRecord(value) &&
    typeof value.id === "string" && PROMPT_ID_PATTERN.test(value.id) &&
    typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version > 0 &&
    typeof value.content_hash === "string" && CONTENT_HASH_PATTERN.test(value.content_hash);
}

function isMetadataEnvelope(value: unknown): value is ObservationMetadata {
  return isRecord(value) && value.schema_version === 1 && isAttributeArray(value.attributes) &&
    (value.prompt_provenance === undefined || value.prompt_provenance === null || isPromptProvenance(value.prompt_provenance));
}

function sanitizeMetadataAttributes(attributes: OtlpAttribute[]): OtlpAttribute[] {
  return attributes.filter((attribute) => !attribute.key.startsWith("astraea.prompt."));
}

/** Canonical observation row from REST and SSE endpoints. */
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
  metadata: ObservationMetadata;
}

export interface TraceListResponse {
  items: TraceRow[];
  total: number;
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

export interface ListObservationsParams {
  limit?: number;
  offset?: number;
  agent_id?: string;
  trace_id?: string;
  type?: string;
  name?: string;
  status?: string;
  duration?: string;
  model?: string;
  input_text?: string;
  time_from?: string;
  time_to?: string;
}

export interface ObservationListResponse {
  items: ObservationRow[];
  total: number;
}

export async function listObservations(params: ListObservationsParams = {}): Promise<ObservationListResponse> {
  const qs = buildQs({
    limit: params.limit,
    offset: params.offset,
    "filter[agent_id]": params.agent_id,
    "filter[trace_id]": params.trace_id,
    "filter[type]": params.type,
    "filter[name]": params.name,
    "filter[status]": params.status,
    "filter[duration]": params.duration,
    "filter[model]": params.model,
    "filter[input_text]": params.input_text,
    "filter[time.from]": params.time_from,
    "filter[time.to]": params.time_to,
  });
  const res = await authedFetch(`/v1/observations${qs}`);
  if (!res.ok) throw new Error(`listObservations ${res.status}`);
  const response = await res.json() as ObservationListResponse;
  return {
    ...response,
    items: response.items.map((observation) => ({
      ...observation,
      metadata: normalizeObservationMetadata(observation.metadata, observation.type === "generation"),
    })),
  };
}

export async function seedRandomTrace(): Promise<{ traceId: string; spanCount: number }> {
  const traceId = crypto.randomUUID().replaceAll("-", "");
  const rootSpanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const spanCount = Math.floor(Math.random() * 10) + 1;
  const startNano = BigInt(Date.now()) * 1_000_000n;
  const endNano = startNano + BigInt(spanCount * 25 + 100) * 1_000_000n;

  const childSpans = Array.from({ length: spanCount - 1 }, (_, index) => {
    const childStart = startNano + BigInt((index + 1) * 25) * 1_000_000n;
    return {
      trace_id: traceId,
      span_id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
      parent_span_id: rootSpanId,
      name: `debug-span-${index + 1}`,
      kind: 1,
      start_time_unix_nano: childStart.toString(),
      end_time_unix_nano: (childStart + 15_000_000n).toString(),
      attributes: [{ key: "deployment.environment", value: { stringValue: "development" } }],
      status: { code: 1 },
    };
  });

  const rootSpan = {
    trace_id: traceId,
    span_id: rootSpanId,
    name: `debug-trace-${traceId.slice(0, 8)}`,
    kind: 1,
    start_time_unix_nano: startNano.toString(),
    end_time_unix_nano: endNano.toString(),
    attributes: [{ key: "deployment.environment", value: { stringValue: "development" } }],
    status: { code: 1 },
  };
  const spans = [...childSpans, rootSpan];

  const res = await authedFetch("/v1/otel/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resource_spans: [{
        resource: { attributes: [] },
        scope_spans: [{ scope: { name: "astraea.sse-debug" }, spans }],
      }],
    }),
  });
  if (!res.ok) throw new Error(`seedRandomTrace ${res.status}`);

  return { traceId, spanCount };
}
