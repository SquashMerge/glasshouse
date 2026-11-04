import { createRoute, z } from "@hono/zod-openapi";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { decodeOtlpTraceExport } from "../lib/otlp-protobuf.js";
import {
	otlpErrorResponse,
	otlpSuccessResponse,
} from "../lib/otlp-response.js";
import { ErrorEnvelope } from "../schemas/common.js";
import {
	ExportTraceServiceRequest,
	ExportTraceServiceResponse,
} from "../schemas/otlp.js";
import { normalizeSpan, resourceProjectId } from "../db/gen-ai-attrs.js";
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
import {
	boundObservationMetadata,
	boundText,
} from "../db/trace-payload-bounds.js";

const tag = "otlp";

export const otlpIngestRoute = createRoute({
	method: "post",
	path: "/v1/traces",
	tags: [tag],
	summary: "OTLP HTTP/JSON trace ingest",
	description:
		"Accepts an ExportTraceServiceRequest (OTLP 1.4.x HTTP/JSON), validates with Zod, " +
		"normalizes each span (gen_ai.* first, OpenInference fallback), and batch-inserts " +
		"to ClickHouse `traces` and `observations`. Returns an empty ExportTraceServiceResponse on success.",
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
			content: { "application/json": { schema: ExportTraceServiceRequest } },
			required: true,
		},
	},
	responses: {
		200: {
			description: "Traces accepted",
			content: { "application/json": { schema: ExportTraceServiceResponse } },
		},
		400: {
			description:
				"Malformed request body or conflicting project provenance for a trace",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		404: {
			description:
				"The OTLP project selector or resource provenance is unavailable to the authenticated organization",
			content: { "application/json": { schema: ErrorEnvelope } },
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
	| { success: true; data: z.infer<typeof ExportTraceServiceRequest> }
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

	if (contentType !== "application/json") {
		try {
			return parseNormalizedOtlpRequest(
				otlpJsonToLegacy(decodeOtlpTraceExport(body)),
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
		return parseNormalizedOtlpRequest(otlpJsonToLegacy(bodyJson));
	} catch {
		return {
			success: false,
			status: 400,
			message: "Invalid ExportTraceServiceRequest",
		};
	}
}

function parseNormalizedOtlpRequest(normalized: unknown): ParsedOtlpRequest {
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
		};
	const parsed = ExportTraceServiceRequest.safeParse(normalized);
	return parsed.success
		? { success: true, data: parsed.data }
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
				resource: resource.resource,
				scope_spans: Array.isArray(scopeSpans)
					? scopeSpans.map((scopeSpan) => {
							if (
								!scopeSpan ||
								typeof scopeSpan !== "object" ||
								Array.isArray(scopeSpan)
							)
								return scopeSpan;
							const scope = scopeSpan as Record<string, unknown>;
							const spans = scope.spans;
							return {
								scope: scope.scope,
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
		parent_span_id: lowerHex(span.parentSpanId ?? span.parent_span_id),
		start_time_unix_nano: span.startTimeUnixNano ?? span.start_time_unix_nano,
		end_time_unix_nano: span.endTimeUnixNano ?? span.end_time_unix_nano,
		trace_state: span.traceState ?? span.trace_state,
	};
}

function lowerHex(value: unknown): unknown {
	if (typeof value === "string") return value.toLowerCase();
	if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte)))
		return Buffer.from(value).toString("hex");
	return value;
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
	request: unknown,
	tenant: OtlpIngestTenantScope,
) {
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				organization_id: tenant.organizationId,
				project_id: tenant.projectId,
				request,
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

		const { request, rejectedSpans } = rejectUnsupportedSpans(parsed.data);
		const deduplicationTokens = otlpDeduplicationTokens(request, tenant);
		const traces = new Map<string, AggregatedTrace>();
		const observations: TenantScopedObservation[] = [];

		try {
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
						);
						for (const ss of rs.scope_spans) {
							for (const sourceSpan of ss.spans) {
								const span = {
									...sourceSpan,
									attributes: redactAttributes(
										sourceSpan.attributes ?? [],
										redaction.redactKeys,
									),
								};
								const normalized = normalizeSpan(
									span,
									resourceAttributes,
									fallbackProjectId,
								);
								const trace: TenantScopedTrace = {
									...normalized.trace,
									organization_id: tenant.organizationId,
								};
								const observation: TenantScopedObservation = {
									...normalized.observation,
									organization_id: tenant.organizationId,
								};
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
					const writer = resolvedDependencies.defaultClient();
					await resolvedDependencies.insertTraces(
						writer,
						[...traces.values()].map(({ trace }) => trace),
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
			return otlpErrorResponse(req, 500);
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

		return otlpSuccessResponse(req, rejectedSpans);
	};
}

function rejectUnsupportedSpans(
	request: z.infer<typeof ExportTraceServiceRequest>,
): {
	request: z.infer<typeof ExportTraceServiceRequest>;
	rejectedSpans: number;
} {
	let rejectedSpans = 0;
	return {
		request: {
			...request,
			resource_spans: request.resource_spans
				.map((resourceSpan) => ({
					...resourceSpan,
					scope_spans: resourceSpan.scope_spans
						.map((scopeSpan) => ({
							...scopeSpan,
							spans: scopeSpan.spans.filter((span) => {
								const unsupported =
									Boolean(span.events?.length) || Boolean(span.links?.length);
								if (unsupported) rejectedSpans += 1;
								return !unsupported;
							}),
						}))
						.filter((scopeSpan) => scopeSpan.spans.length > 0),
				}))
				.filter((resourceSpan) => resourceSpan.scope_spans.length > 0),
		} as z.infer<typeof ExportTraceServiceRequest>,
		rejectedSpans,
	};
}

function redactAttributes<T extends { key: string }>(
	attributes: T[],
	keys: string[],
): T[] {
	if (!keys.length) return attributes;
	const redacted = new Set(keys);
	return attributes.filter((attribute) => !redacted.has(attribute.key));
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
	return {
		isRoot: existing.isRoot || nextIsRoot,
		trace: {
			...identity,
			start_time,
			end_time,
			duration_ms:
				end_time === null
					? null
					: Math.max(
							0,
							new Date(end_time).getTime() - new Date(start_time).getTime(),
						),
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
