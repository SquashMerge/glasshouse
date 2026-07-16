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
