// Normalize OTLP span attributes into our internal Trace / Observation shape.
// gen_ai.* (OTel GenAI semantic conventions) wins; OpenInference is the fallback.

import type { Span } from "../schemas/otlp.js";
import {
	observationMetadata,
	promptProvenanceFromAttributes,
	type ObservationMetadata,
	type OtlpAttribute,
} from "./observation-metadata.js";

type Attribute = OtlpAttribute & {
	value?: {
		stringValue?: string;
		intValue?: number | string;
		boolValue?: boolean;
		doubleValue?: number;
	};
};

const projectIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function attrString(attrs: Attribute[], key: string): string | undefined {
	const a = attrs.find((x) => x.key === key);
	if (!a) return undefined;
	const v = a.value;
	return v?.stringValue;
}

export function resourceProjectId(attrs: OtlpAttribute[]): string {
	const value = attrs.find(
		(attribute) => attribute.key === "glasshouse.project.id",
	)?.value;
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		typeof (value as { stringValue?: unknown }).stringValue !== "string"
	)
		return "";
	const projectId = (value as { stringValue: string }).stringValue;
	return projectIdPattern.test(projectId) ? projectId.toLowerCase() : "";
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

export interface NormalizedTrace {
	trace_id: string;
	project_id: string;
	name: string;
	start_time: string; // ISO datetime
	end_time: string | null; // ISO datetime or null for in-flight spans
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
	input_retained_truncated?: boolean;
	output_retained_truncated?: boolean;
	scores_summary: string; // CSV of name:value pairs
}

export interface NormalizedObservation {
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
	input_retained_truncated?: boolean;
	output_retained_truncated?: boolean;
	metadata: ObservationMetadata;
}

function isoFromUnixNano(nano: number): string {
	// OTLP timestamps are nanoseconds since epoch; JS Date is milliseconds.
	// Format as `YYYY-MM-DD HH:MM:SS.fff` (UTC) — ClickHouse's JSONEachRow parser
	// doesn't accept the ISO `T`/`Z` form for DateTime64.
	const d = new Date(Math.floor(nano / 1_000_000));
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return (
		`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
		`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
	);
}

function durationMs(
	startNano: number | undefined,
	endNano: number | undefined,
): number | null {
	if (startNano === undefined || endNano === undefined) return null;
	return Math.max(0, Math.round((endNano - startNano) / 1_000_000));
}

function scorePairsAsCsv(pairs: Array<[string, number]>): string {
	return pairs.map(([k, v]) => `${k}:${v}`).join(",");
}

function classifySpanType(
	attrs: Attribute[],
): "span" | "event" | "generation" | "tool" {
	// OpenInference span kind wins when present (most expressive).
	const oi = attrString(attrs, "openinference.span.kind");
	if (oi) {
		const lower = oi.toLowerCase();
		if (lower === "llm" || lower === "chain" || lower === "agent")
			return "generation";
		if (lower === "tool" || lower === "retriever") return "tool";
		if (lower === "embedding" || lower === "reranker") return "tool";
	}
	if (
		attrs.some(
			(a) =>
				a.key === "gen_ai.request.model" || a.key === "gen_ai.response.model",
		)
	)
		return "generation";
	if (attrs.some((a) => a.key === "tool.name")) return "tool";
	return "span";
}

export function normalizeSpan(
	span: Span,
	resourceAttributes: OtlpAttribute[] = [],
	fallbackProjectId = "",
): {
	trace: NormalizedTrace;
	observation: NormalizedObservation;
} {
	const attrs = (span.attributes ?? []) as Attribute[];
	const projectId = resourceProjectId(resourceAttributes) || fallbackProjectId;

	// gen_ai.* takes precedence over OpenInference.
	const agentId =
		attrString(attrs, "gen_ai.agent.id") ?? attrString(attrs, "agent.id") ?? "";
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
		attrString(attrs, "enduser.id") ?? attrString(attrs, "user.id") ?? "";
	const sessionId = attrString(attrs, "session.id") ?? "";

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

	const scorePairs: Array<[string, number]> = [];
	const inTok =
		attrNumber(attrs, "gen_ai.usage.input_tokens") ??
		attrNumber(attrs, "llm.token_count.prompt");
	const outTok =
		attrNumber(attrs, "gen_ai.usage.output_tokens") ??
		attrNumber(attrs, "llm.token_count.completion");
	if (inTok !== undefined) scorePairs.push(["input_tokens", inTok]);
	if (outTok !== undefined) scorePairs.push(["output_tokens", outTok]);
	const scoresCsv = scorePairsAsCsv(scorePairs);

	let status: "ok" | "error" = "ok";
	if (span.status?.code === 2) status = "error";
	const exc = attrs.find((a) => a.key === "exception.type");
	if (exc) status = "error";

	const tags: string[] = [];
	if (span.kind !== undefined) tags.push(`span.kind:${span.kind}`);
	const oiKind = attrString(attrs, "openinference.span.kind");
	if (oiKind) tags.push(`openinference.span.kind:${oiKind}`);

	const trace: NormalizedTrace = {
		trace_id: span.trace_id,
		project_id: projectId,
		name: span.name,
		start_time: isoFromUnixNano(span.start_time_unix_nano as unknown as number),
		end_time:
			span.end_time_unix_nano !== undefined
				? isoFromUnixNano(span.end_time_unix_nano as unknown as number)
				: null,
		duration_ms: durationMs(
			span.start_time_unix_nano as unknown as number,
			span.end_time_unix_nano as unknown as number,
		),
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

	const type = classifySpanType(attrs);
	const observation: NormalizedObservation = {
		observation_id: span.span_id,
		trace_id: span.trace_id,
		project_id: projectId,
		parent_observation_id: span.parent_span_id ?? null,
		type,
		name: span.name,
		start_time: trace.start_time,
		end_time: trace.end_time,
		duration_ms: trace.duration_ms,
		status,
		model: model || null,
		input_text: inputText,
		output_text: outputText,
		metadata: observationMetadata(
			attrs,
			promptProvenanceFromAttributes(attrs, type === "generation"),
		),
	};

	return { trace, observation };
}
