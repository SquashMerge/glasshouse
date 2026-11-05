import { createRoute, z } from "@hono/zod-openapi";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { decodeOtlpTraceExport } from "../lib/otlp-protobuf.js";
import {
	otlpErrorResponse,
	otlpSuccessResponse,
} from "../lib/otlp-response.js";
import {
	ExportTraceServiceRequest,
	OtlpError,
	OtlpWireRequest,
	OtlpWireResponse,
} from "../schemas/otlp.js";
import { normalizeSpan, resourceProjectId } from "../db/gen-ai-attrs.js";
import { promptProvenanceFromAttributes } from "../db/observation-metadata.js";
import {
	policyRedactionOptions,
	redactMetadata,
	redactTraceText,
} from "../db/redact.js";
import { approvedRedaction } from "../db/governance.js";
import {
	insertObservations,
	insertTraces,
	defaultClient,
	type TenantScopedObservation,
	type TenantScopedTrace,
} from "../db/traces-writer.js";
import {
	type TenantScope,
	TenantScopeError,
	withActiveAuthorizedProjectLock as lockActiveAuthorizedProject,
} from "../tenancy.js";
import { pgPool } from "../db/postgres.js";
import { publishSync } from "../lib/event-bus.js";
import { logger } from "../lib/logger.js";
import { isTransientStorageFailure } from "../lib/transient-storage-error.js";
import {
	boundObservationMetadata,
	boundText,
	utf8ByteLength,
} from "../db/trace-payload-bounds.js";
import {
	boundOtlpDetail,
	MAX_OTLP_REQUEST_DETAIL_BYTES,
	MAX_OTLP_DETAIL_BYTES,
} from "../db/otlp-detail.js";

const tag = "otlp";
const protobufWire = z.string().openapi({ type: "string", format: "binary" });
const otlpErrorContent = {
	"application/json": { schema: OtlpError },
	"application/x-protobuf": { schema: protobufWire },
};

export const otlpIngestRoute = createRoute({
	method: "post",
	path: "/v1/traces",
	tags: [tag],
	summary: "OTLP HTTP trace ingest",
	description:
		"Accepts OTLP JSON or protobuf trace exports, with at most 2,000 spans per request and 512 events/links per span. Known message objects and repeated-field arrays may nest at most 32 levels below the request root. JSON null fields are treated as unset; null repeated elements are invalid. Resource glasshouse.project.id must occur at most once, contain only a UUID string value with no unknown fields, and match the authorized Project header; missing resource selectors inherit that Project. Spans require valid IDs, a name, and an exact uint64 start time (unsafe JSON numbers are rejected; use decimal strings). Events, links and resource/scope/status context are redacted and retained in bounded OTLP detail (32 KiB per span, 8 MiB per export); truncation is explicit on readback.",
	security: [
		{ sessionCookie: [], csrfHeader: [] },
		{ basicAuth: [] },
		{ bearerAuth: [] },
	],
	request: {
		headers: z.object({
			"x-glasshouse-project-id": z.string().uuid().openapi({
				description:
					"Project selector, verified against the authenticated organization",
			}),
		}),
		body: {
			content: {
				"application/json": { schema: OtlpWireRequest },
				"application/x-protobuf": { schema: protobufWire },
				"application/protobuf": { schema: protobufWire },
			},
			required: true,
		},
	},
	responses: {
		200: {
			description: "Traces accepted, possibly with partial success",
			content: {
				"application/json": { schema: OtlpWireResponse },
				"application/x-protobuf": { schema: protobufWire },
			},
		},
		400: {
			description: "Malformed request or conflicting provenance",
			content: otlpErrorContent,
		},
		404: {
			description: "Project unavailable to the authenticated organization",
			content: otlpErrorContent,
		},
		413: {
			description: "Request exceeds the configured limit",
			content: otlpErrorContent,
		},
		415: {
			description: "Unsupported media type or content encoding",
			content: otlpErrorContent,
		},
		500: { description: "Trace export failed", content: otlpErrorContent },
		503: {
			description: "Trace export temporarily unavailable",
			content: otlpErrorContent,
		},
	},
});

export type OtlpIngestTenantScope = Pick<
	TenantScope,
	"actorId" | "organizationId" | "projectId" | "ingestCredential"
>;

export type OtlpIngestDependencies = {
	defaultClient: typeof defaultClient;
	insertObservations: typeof insertObservations;
	insertTraces: typeof insertTraces;
	publishSync: typeof publishSync;
	approvedRedaction: typeof approvedRedaction;
	withActiveAuthorizedProjectLock: <T>(
		tenant: OtlpIngestTenantScope,
		callback: (client: Parameters<typeof approvedRedaction>[0]) => Promise<T>,
	) => Promise<T>;
};

export async function resourceProjectIds(
	req: Request,
): Promise<ReadonlySet<string>> {
	const parsed = await parseOtlpHttpRequest(req.clone());
	if (!parsed.success) return new Set();

	return new Set(
		parsed.data.resource_spans
			.map((resourceSpan) =>
				resourceProjectId(resourceSpan.resource?.attributes ?? []),
			)
			.filter(Boolean),
	);
}

const configuredOtlpBodyLimit = Number(process.env.API_MAX_BODY_BYTES);
const MAX_OTLP_DECOMPRESSED_BYTES =
	Number.isSafeInteger(configuredOtlpBodyLimit) && configuredOtlpBodyLimit > 0
		? configuredOtlpBodyLimit
		: 1_048_576;

type ParsedOtlpRequest =
	| {
			success: true;
			data: z.infer<typeof ExportTraceServiceRequest>;
			wireDigest: string;
	  }
	| { success: false; status: 400 | 413 | 415; message: string };

async function parseOtlpHttpRequest(req: {
	headers: {
		get: (name: string) => string | null;
		has: (name: string) => boolean;
	};
	arrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<ParsedOtlpRequest> {
	const contentType =
		req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ??
		"application/json";
	if (
		contentType !== "application/json" &&
		contentType !== "application/x-protobuf" &&
		contentType !== "application/protobuf"
	)
		return {
			success: false,
			status: 415,
			message: "OTLP trace export requires application/json",
		};

	let body: Uint8Array;
	try {
		body = new Uint8Array(await req.arrayBuffer());
		if (req.headers.get("content-encoding")?.toLowerCase() === "gzip")
			body = gunzipSync(body, { maxOutputLength: MAX_OTLP_DECOMPRESSED_BYTES });
		else if (req.headers.has("content-encoding"))
			return {
				success: false,
				status: 415,
				message: "Unsupported content encoding",
			};
	} catch (cause) {
		return {
			success: false,
			status: isGzipLimitError(cause) ? 413 : 400,
			message: isGzipLimitError(cause)
				? "OTLP request exceeds the decompressed body limit"
				: "Request body is not valid OTLP JSON",
		};
	}
	if (body.byteLength > MAX_OTLP_DECOMPRESSED_BYTES)
		return {
			success: false,
			status: 413,
			message: "OTLP request exceeds the decompressed body limit",
		};

	// Hash bounded, decompressed bytes, never recursively serialize unknown JSON.
	const wireDigest = createHash("sha256")
		.update(contentType === "application/json" ? "json\0" : "protobuf\0")
		.update(body)
		.digest("hex");
	if (contentType !== "application/json") {
		try {
			return parseNormalizedOtlpRequest(
				otlpJsonToLegacy(normalizeOtlpFields(decodeOtlpTraceExport(body))),
				wireDigest,
			);
		} catch {
			return {
				success: false,
				status: 400,
				message: "Request body is not valid OTLP protobuf",
			};
		}
	}

	let bodyJson: unknown;
	try {
		bodyJson = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return {
			success: false,
			status: 400,
			message: "Request body is not valid OTLP JSON",
		};
	}
	try {
		return parseNormalizedOtlpRequest(
			otlpJsonToLegacy(normalizeOtlpFields(bodyJson)),
			wireDigest,
		);
	} catch {
		return {
			success: false,
			status: 400,
			message: "Invalid ExportTraceServiceRequest",
		};
	}
}

function parseNormalizedOtlpRequest(
	normalized: unknown,
	wireDigest: string,
): ParsedOtlpRequest {
	if (
		normalized &&
		typeof normalized === "object" &&
		Array.isArray(
			(normalized as { resource_spans?: unknown }).resource_spans,
		) &&
		(normalized as { resource_spans: unknown[] }).resource_spans.length === 0
	)
		return {
			success: true,
			data: { resource_spans: [] } as z.infer<typeof ExportTraceServiceRequest>,
			wireDigest,
		};
	const parsed = ExportTraceServiceRequest.safeParse(normalized);
	if (parsed.success)
		for (const rs of parsed.data.resource_spans)
			resourceProjectId(rs.resource?.attributes ?? []);
	return parsed.success
		? { success: true, data: parsed.data, wireDigest }
		: {
				success: false,
				status: 400,
				message: "Invalid ExportTraceServiceRequest",
			};
}

function otlpJsonToLegacy(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const request = value as Record<string, unknown>;
	const resourceSpans = request.resourceSpans ?? request.resource_spans ?? [];
	if (!Array.isArray(resourceSpans)) return value;
	return {
		resource_spans: resourceSpans.map((resourceSpan) => {
			if (
				!resourceSpan ||
				typeof resourceSpan !== "object" ||
				Array.isArray(resourceSpan)
			)
				return resourceSpan;
			const resource = resourceSpan as Record<string, unknown>;
			const scopeSpans = resource.scopeSpans ?? resource.scope_spans;
			return {
				resource: otlpContextToLegacy(resource.resource),
				schema_url: resource.schemaUrl ?? resource.schema_url,
				scope_spans: Array.isArray(scopeSpans)
					? scopeSpans.map((scopeSpan) => {
							if (
								!scopeSpan ||
								typeof scopeSpan !== "object" ||
								Array.isArray(scopeSpan)
							)
								return scopeSpan;
							const scope = scopeSpan as Record<string, unknown>;
							const spans = scope.spans ?? undefined;
							return {
								scope: otlpContextToLegacy(scope.scope),
								schema_url: scope.schemaUrl ?? scope.schema_url,
								spans: Array.isArray(spans)
									? spans.map((span) => otlpSpanToLegacy(span))
									: spans,
							};
						})
					: scopeSpans,
			};
		}),
	};
}

function otlpSpanToLegacy(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const span = value as Record<string, unknown>;
	return {
		...span,
		trace_id: lowerHex(span.traceId ?? span.trace_id),
		span_id: lowerHex(span.spanId ?? span.span_id),
		parent_span_id: lowerParentSpanId(span.parentSpanId ?? span.parent_span_id),
		start_time_unix_nano: span.startTimeUnixNano ?? span.start_time_unix_nano,
		end_time_unix_nano: span.endTimeUnixNano ?? span.end_time_unix_nano,
		trace_state: span.traceState ?? span.trace_state,
		dropped_attributes_count:
			span.droppedAttributesCount ?? span.dropped_attributes_count,
		dropped_events_count: span.droppedEventsCount ?? span.dropped_events_count,
		dropped_links_count: span.droppedLinksCount ?? span.dropped_links_count,
		events: Array.isArray(span.events)
			? span.events.map((event) => {
					const e = otlpContextToLegacy(event) as Record<string, unknown>;
					return { ...e, time_unix_nano: e.timeUnixNano ?? e.time_unix_nano };
				})
			: span.events,
		links: Array.isArray(span.links)
			? span.links.map((link) => {
					const l = otlpContextToLegacy(link) as Record<string, unknown>;
					return {
						...l,
						trace_id: lowerHex(l.traceId ?? l.trace_id),
						span_id: lowerHex(l.spanId ?? l.span_id),
						trace_state: l.traceState ?? l.trace_state,
					};
				})
			: span.links,
	};
}

function otlpContextToLegacy(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const context = value as Record<string, unknown>;
	return {
		...context,
		dropped_attributes_count:
			context.droppedAttributesCount ?? context.dropped_attributes_count,
	};
}

function lowerParentSpanId(value: unknown): unknown {
	return value === "" || (Array.isArray(value) && value.length === 0)
		? undefined
		: lowerHex(value);
}

function lowerHex(value: unknown): unknown {
	if (typeof value === "string") return value.toLowerCase();
	if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte)))
		return Buffer.from(value).toString("hex");
	return value;
}

const OTLP_MESSAGE_FIELDS = {
	request: { resourceSpans: "resourceSpan", resource_spans: "resourceSpan" },
	resourceSpan: {
		resource: "resource",
		scopeSpans: "scopeSpan",
		scope_spans: "scopeSpan",
	},
	resource: { attributes: "attribute" },
	scopeSpan: { scope: "scope", spans: "span" },
	scope: { attributes: "attribute" },
	span: {
		attributes: "attribute",
		status: "status",
		events: "event",
		links: "link",
	},
	status: {},
	event: { attributes: "attribute" },
	link: { attributes: "attribute" },
	attribute: { value: "value" },
	value: { arrayValue: "arrayValue", kvlistValue: "kvlistValue" },
	arrayValue: { values: "value" },
	kvlistValue: { values: "attribute" },
} as const;
type OtlpMessage = keyof typeof OTLP_MESSAGE_FIELDS;

function normalizeOtlpFields(
	value: unknown,
	depth = 0,
	message: OtlpMessage = "request",
): unknown {
	if (depth > 32) throw new Error("OTLP message nesting limit exceeded");
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value))
		return value.map((item) => {
			if (item === null) throw new Error("Invalid null repeated element");
			return normalizeOtlpFields(item, depth + 1, message);
		});
	const object = value as Record<string, unknown>;
	const normalized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(object)) {
		// Preserve unknown nested fields for fail-closed attribute redaction.
		const knownField =
			(message !== "attribute" &&
				message !== "value" &&
				message !== "arrayValue" &&
				message !== "kvlistValue") ||
			(message === "attribute"
				? key === "key" || key === "value"
				: message === "value"
					? OTLP_ANY_VALUE_KEYS.has(key)
					: key === "values");
		if (child === null && knownField) continue;
		if (
			message === "value" &&
			key === "bytesValue" &&
			Array.isArray(child) &&
			child.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
		)
			normalized[key] = Buffer.from(child).toString("base64");
		else {
			const fields = OTLP_MESSAGE_FIELDS[message] as Readonly<
				Record<string, OtlpMessage>
			>;
			const childMessage = Object.hasOwn(fields, key) ? fields[key] : undefined;
			normalized[key] = childMessage
				? normalizeOtlpFields(child, depth + 1, childMessage)
				: child;
		}
	}
	return normalized;
}

function isGzipLimitError(cause: unknown): boolean {
	return (
		cause instanceof Error &&
		"code" in cause &&
		cause.code === "ERR_BUFFER_TOO_LARGE"
	);
}

type AggregatedTrace = {
	trace: TenantScopedTrace;
	isRoot: boolean;
};

class OtlpConflictError extends Error {}

const productionOtlpIngestDependencies: OtlpIngestDependencies = {
	defaultClient,
	insertObservations,
	insertTraces,
	publishSync,
	approvedRedaction,
	withActiveAuthorizedProjectLock: (tenant, callback) =>
		lockActiveAuthorizedProject(pgPool(), tenant as TenantScope, callback),
};

function otlpDeduplicationTokens(
	wireDigest: string,
	tenant: OtlpIngestTenantScope,
	fallbackProjectId: string,
) {
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				identity: "otlp-wire-v1",
				organization_id: tenant.organizationId,
				project_id: tenant.projectId,
				fallback_project_id: fallbackProjectId,
				wire_digest: wireDigest,
			}),
		)
		.digest("hex");
	return {
		traces: `glasshouse:otlp:traces:${digest}`,
		observations: `glasshouse:otlp:observations:${digest}`,
	};
}

export function createOtlpIngestHandler(
	dependencies: Partial<OtlpIngestDependencies> = {},
) {
	const resolvedDependencies: OtlpIngestDependencies = {
		...productionOtlpIngestDependencies,
		...dependencies,
	};
	return async function handleOtlpIngest(
		req: Request,
		tenant: OtlpIngestTenantScope,
		fallbackProjectId = tenant.projectId,
	): Promise<Response> {
		const parsed = await parseOtlpHttpRequest(req);
		if (!parsed.success) {
			return otlpErrorResponse(req, parsed.status);
		}

		const request = parsed.data;
		const spanCount = request.resource_spans.reduce(
			(total, rs) =>
				total +
				rs.scope_spans.reduce((count, ss) => count + ss.spans.length, 0),
			0,
		);
		let remainingDetailBytes = MAX_OTLP_REQUEST_DETAIL_BYTES - spanCount * 64;
		const traces = new Map<string, AggregatedTrace>();
		const observations: TenantScopedObservation[] = [];

		try {
			if (
				fallbackProjectId !== tenant.projectId ||
				request.resource_spans.some((rs) => {
					const projectId = resourceProjectId(rs.resource?.attributes ?? []);
					return projectId !== "" && projectId !== tenant.projectId;
				})
			)
				throw new OtlpConflictError("Conflicting Project selectors");
			await resolvedDependencies.withActiveAuthorizedProjectLock(
				tenant,
				async (client) => {
					// Resolve while holding the project lock so an approval cannot race an
					// in-flight ingest. Strip configured keys before normalization derives
					// identity fields such as trace.user_id.
					const policy = await resolvedDependencies.approvedRedaction(
						client,
						tenant.organizationId,
						tenant.projectId,
					);
					const redaction = policyRedactionOptions(
						policy ?? { mode: "none", keys: [] },
					);
					for (const rs of request.resource_spans) {
						const resourceAttributes = redactAttributes(
							rs.resource?.attributes ?? [],
							redaction.redactKeys,
							redaction.redactInput,
						);
						for (const ss of rs.scope_spans) {
							for (const sourceSpan of ss.spans) {
								const span = {
									...sourceSpan,
									name: redactTraceText(sourceSpan.name, redaction),
									attributes: redactAttributes(
										sourceSpan.attributes ?? [],
										redaction.redactKeys,
										redaction.redactInput,
										true,
									),
								};
								const normalized = normalizeSpan(span, [], tenant.projectId);
								const trace: TenantScopedTrace = {
									...normalized.trace,
									organization_id: tenant.organizationId,
								};
								const observation: TenantScopedObservation = {
									...normalized.observation,
									organization_id: tenant.organizationId,
								};
								observation.metadata.prompt_provenance =
									promptProvenanceFromAttributes(
										(sourceSpan.attributes ?? []).filter(
											(attribute) =>
												!redaction.redactKeys.includes(attribute.key),
										),
										observation.type === "generation",
									);
								const text = (value: string | undefined) =>
									value === undefined
										? undefined
										: redactTraceText(value, redaction);
								const attributes = (
									value: typeof span.attributes | undefined,
								) =>
									redactAttributes(
										value ?? [],
										redaction.redactKeys,
										redaction.redactInput,
									);
								observation.otlp = boundOtlpDetail(
									{
										resource: rs.resource
											? { ...rs.resource, attributes: resourceAttributes }
											: undefined,
										resource_schema_url: text(rs.schema_url),
										scope: ss.scope
											? {
													...ss.scope,
													name: text(ss.scope.name),
													version: text(ss.scope.version),
													attributes: attributes(ss.scope.attributes),
												}
											: undefined,
										scope_schema_url: text(ss.schema_url),
										kind: span.kind,
										flags: span.flags,
										trace_state: text(span.trace_state),
										dropped_attributes_count: span.dropped_attributes_count,
										dropped_events_count: span.dropped_events_count,
										dropped_links_count: span.dropped_links_count,
										status: span.status
											? { ...span.status, message: text(span.status.message) }
											: undefined,
										attributes: observation.metadata.attributes,
										events: span.events?.map((event) => ({
											...event,
											name: text(event.name),
											attributes: attributes(event.attributes),
										})),
										links: span.links?.map((link) => ({
											...link,
											trace_state: text(link.trace_state),
											attributes: attributes(link.attributes),
										})),
									},
									Math.min(MAX_OTLP_DETAIL_BYTES, 64 + remainingDetailBytes),
								);
								remainingDetailBytes = Math.max(
									0,
									remainingDetailBytes -
										Math.max(
											0,
											utf8ByteLength(JSON.stringify(observation.otlp)) - 64,
										),
								);
								const existingTrace = traces.get(trace.trace_id);
								if (
									existingTrace &&
									existingTrace.trace.project_id !== trace.project_id
								) {
									throw new OtlpConflictError(
										"Trace contains conflicting project provenance",
									);
								}
								trace.input_text = redactTraceText(trace.input_text, redaction);
								trace.output_text = redactTraceText(
									trace.output_text,
									redaction,
								);
								const input = boundText(trace.input_text);
								const output = boundText(trace.output_text);
								trace.input_text = input.value;
								trace.output_text = output.value;
								trace.input_retained_truncated = input.truncated;
								trace.output_retained_truncated = output.truncated;
								observation.input_text = input.value;
								observation.output_text = output.value;
								observation.input_retained_truncated = input.truncated;
								observation.output_retained_truncated = output.truncated;
								observation.metadata = boundObservationMetadata(
									redactMetadata(observation.metadata, redaction),
								);
								const isRoot = observation.parent_observation_id === null;
								traces.set(
									trace.trace_id,
									aggregateTrace(existingTrace, trace, isRoot),
								);
								observations.push(observation);
							}
						}
					}
					const traceRows = [...traces.values()].map(({ trace }) => trace);
					const deduplicationTokens = otlpDeduplicationTokens(
						parsed.wireDigest,
						tenant,
						fallbackProjectId,
					);
					const writer = resolvedDependencies.defaultClient();
					await resolvedDependencies.insertTraces(
						writer,
						traceRows,
						deduplicationTokens.traces,
					);
					await resolvedDependencies.insertObservations(
						writer,
						observations,
						deduplicationTokens.observations,
					);
				},
			);
		} catch (err) {
			if (err instanceof TenantScopeError) throw err;
			if (err instanceof OtlpConflictError) return otlpErrorResponse(req, 400);
			logger.error("otlp.persist_failed", err);
			return otlpErrorResponse(req, isTransientStorageFailure(err) ? 503 : 500);
		}

		try {
			for (const { trace } of traces.values())
				resolvedDependencies.publishSync("trace.created", { trace });
			for (const o of observations)
				resolvedDependencies.publishSync("observation.created", {
					observation: o,
				});
		} catch (err) {
			logger.warn("otlp.event_publish_failed", err, {});
		}

		return otlpSuccessResponse(req, 0);
	};
}

const MAX_OTLP_REDACTION_DEPTH = 32;
const MAX_OTLP_REDACTION_NODES = 4_096;
const OTLP_ANY_VALUE_KEYS = new Set([
	"stringValue",
	"boolValue",
	"intValue",
	"doubleValue",
	"arrayValue",
	"kvlistValue",
	"bytesValue",
]);
const OPENINFERENCE_KINDS = new Set([
	"llm",
	"chain",
	"agent",
	"tool",
	"retriever",
	"embedding",
	"reranker",
]);

function redactAttributes<T extends { key: string }>(
	attributes: T[],
	keys: string[],
	allText = false,
	spanStructure = false,
): T[] {
	const redacted = new Set(keys);
	const budget = {
		remaining: MAX_OTLP_REDACTION_NODES,
		spanStructure,
	};
	return attributes.flatMap((attribute) => {
		const value = redactAttribute(attribute, redacted, budget, 0, allText);
		return value === null ? [] : [value as T];
	});
}

function redactAttribute(
	attribute: { key: string },
	keys: ReadonlySet<string>,
	budget: { remaining: number; spanStructure?: boolean },
	depth: number,
	allText: boolean,
): object | null {
	if (budget.remaining <= 0 || depth > MAX_OTLP_REDACTION_DEPTH) return null;
	budget.remaining -= 1;
	if (!attribute || typeof attribute !== "object" || Array.isArray(attribute))
		return null;
	const source = attribute as Record<string, unknown>;
	if (
		typeof source.key !== "string" ||
		Object.keys(source).some((key) => key !== "key" && key !== "value")
	)
		return null;
	if (keys.has(attribute.key) || attribute.key.startsWith("glasshouse.prompt."))
		return null;
	if (!("value" in source)) return { key: attribute.key };
	const kind = (source.value as { stringValue?: unknown } | undefined)
		?.stringValue;
	const structuralKind =
		depth === 0 &&
		budget.spanStructure &&
		attribute.key === "openinference.span.kind" &&
		typeof kind === "string" &&
		OPENINFERENCE_KINDS.has(kind.toLowerCase());
	const value = redactAttributeValue(
		source.value,
		keys,
		budget,
		depth + 1,
		allText && !structuralKind,
	);
	return value === null ? null : { key: attribute.key, value };
}

function redactAttributeValue(
	value: unknown,
	keys: ReadonlySet<string>,
	budget: { remaining: number },
	depth: number,
	allText: boolean,
): unknown | null {
	if (budget.remaining <= 0 || depth > MAX_OTLP_REDACTION_DEPTH) return null;
	budget.remaining -= 1;
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const anyValue = value as Record<string, unknown>;
	const valueKeys = Object.keys(anyValue);
	if (valueKeys.length === 0) return {};
	if (valueKeys.length !== 1 || !OTLP_ANY_VALUE_KEYS.has(valueKeys[0] ?? ""))
		return null;

	switch (valueKeys[0]) {
		case "stringValue":
			return typeof anyValue.stringValue === "string"
				? {
						stringValue:
							allText && anyValue.stringValue
								? "[REDACTED]"
								: anyValue.stringValue,
					}
				: null;
		case "boolValue":
			return typeof anyValue.boolValue === "boolean"
				? { boolValue: anyValue.boolValue }
				: null;
		case "intValue":
			return typeof anyValue.intValue === "string" ||
				(typeof anyValue.intValue === "number" &&
					Number.isInteger(anyValue.intValue))
				? { intValue: anyValue.intValue }
				: null;
		case "doubleValue":
			return typeof anyValue.doubleValue === "number" ||
				["NaN", "Infinity", "-Infinity"].includes(
					anyValue.doubleValue as string,
				)
				? { doubleValue: anyValue.doubleValue }
				: null;
		case "bytesValue":
			return typeof anyValue.bytesValue === "string"
				? {
						bytesValue:
							allText && anyValue.bytesValue
								? "[REDACTED]"
								: anyValue.bytesValue,
					}
				: null;
		case "arrayValue":
			return redactAnyValueCollection(
				anyValue.arrayValue,
				keys,
				budget,
				depth,
				"arrayValue",
				allText,
			);
		case "kvlistValue":
			return redactAnyValueCollection(
				anyValue.kvlistValue,
				keys,
				budget,
				depth,
				"kvlistValue",
				allText,
			);
		default:
			return null;
	}
}

function redactAnyValueCollection(
	value: unknown,
	keys: ReadonlySet<string>,
	budget: { remaining: number },
	depth: number,
	type: "arrayValue" | "kvlistValue",
	allText: boolean,
): object | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const collection = value as Record<string, unknown>;
	if (Object.keys(collection).some((key) => key !== "values")) return null;
	if (!("values" in collection)) return { [type]: {} };
	if (!Array.isArray(collection.values)) return null;
	const values = collection.values.flatMap((item) => {
		const nested =
			type === "arrayValue"
				? redactAttributeValue(item, keys, budget, depth + 1, allText)
				: redactAttribute(
						item as { key: string },
						keys,
						budget,
						depth + 1,
						allText,
					);
		return nested === null ? [] : [nested];
	});
	return { [type]: { values } };
}

function aggregateTrace(
	existing: AggregatedTrace | undefined,
	next: TenantScopedTrace,
	nextIsRoot: boolean,
): AggregatedTrace {
	if (!existing) return { trace: next, isRoot: nextIsRoot };

	// The root supplies the trace identity; all observations supply timing/status.
	const identity = nextIsRoot && !existing.isRoot ? next : existing.trace;
	const start_time =
		existing.trace.start_time < next.start_time
			? existing.trace.start_time
			: next.start_time;
	const end_time = latestTime(existing.trace.end_time, next.end_time);
	const starts = [
		existing.trace.start_time_unix_nano,
		next.start_time_unix_nano,
	]
		.filter((value): value is string => value != null)
		.map(BigInt);
	const ends = [existing.trace.end_time_unix_nano, next.end_time_unix_nano]
		.filter((value): value is string => value != null)
		.map(BigInt);
	const startNano = starts.reduce((a, b) => (a < b ? a : b));
	const endNano = ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : null;
	const durationNano =
		endNano === null ? null : endNano > startNano ? endNano - startNano : 0n;
	return {
		isRoot: existing.isRoot || nextIsRoot,
		trace: {
			...identity,
			start_time,
			end_time,
			start_time_unix_nano: startNano.toString(),
			end_time_unix_nano: endNano?.toString() ?? null,
			duration_nano: durationNano?.toString() ?? null,
			duration_ms:
				durationNano === null ? null : Number(durationNano) / 1_000_000,
			status:
				existing.trace.status === "error" || next.status === "error"
					? "error"
					: "ok",
		},
	};
}

function latestTime(left: string | null, right: string | null): string | null {
	if (!left) return right;
	if (!right) return left;
	return left > right ? left : right;
}

export const handleOtlpIngest = createOtlpIngestHandler();
