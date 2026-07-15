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

/**
 * Canonical row shape returned by `GET /v1/observations` and the
 * `GET /v1/observations/events` SSE stream. `metadata` is a JSON-encoded
 * string (parsed lazily by the UI when the user expands a row).
 */
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

function buildQs(
	params: Record<string, string | number | undefined | null>,
): string {
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

export async function listTraces(
	params: ListTracesParams = {},
): Promise<TraceListResponse> {
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

export async function listObservations(
	params: ListObservationsParams = {},
): Promise<ObservationListResponse> {
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
	return res.json();
}

export async function seedRandomTrace(): Promise<{
	traceId: string;
	spanCount: number;
}> {
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
			attributes: [
				{
					key: "deployment.environment",
					value: { stringValue: "development" },
				},
			],
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
		attributes: [
			{ key: "deployment.environment", value: { stringValue: "development" } },
		],
		status: { code: 1 },
	};
	const spans = [...childSpans, rootSpan];

	const res = await authedFetch("/v1/otel/v1/traces", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			resource_spans: [
				{
					resource: { attributes: [] },
					scope_spans: [{ scope: { name: "astraea.sse-debug" }, spans }],
				},
			],
		}),
	});
	if (!res.ok) throw new Error(`seedRandomTrace ${res.status}`);

	return { traceId, spanCount };
}
