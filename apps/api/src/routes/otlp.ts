import { createRoute, z } from "@hono/zod-openapi";
import { createHash } from "node:crypto";
import { ErrorEnvelope } from "../schemas/common.js";
import {
	ExportTraceServiceRequest,
	ExportTraceServiceResponse,
} from "../schemas/otlp.js";
import { normalizeSpan, resourceProjectId } from "../db/gen-ai-attrs.js";
import {
	loadRedactionOptions,
	redactMetadata,
	redactTraceText,
} from "../db/redact.js";
import {
	insertObservations,
	insertTraces,
	defaultClient,
	type TenantScopedObservation,
	type TenantScopedTrace,
} from "../db/traces-writer.js";
import type { TenantScope } from "../tenancy.js";
import { publishSync } from "../lib/event-bus.js";
import { logger } from "../lib/logger.js";

const tag = "otlp";

export const otlpIngestRoute = createRoute({
	method: "post",
	path: "/v1/otel/v1/traces",
	tags: [tag],
	summary: "OTLP HTTP/JSON trace ingest",
	description:
		"Accepts an ExportTraceServiceRequest (OTLP 1.4.x HTTP/JSON), validates with Zod, " +
		"normalizes each span (gen_ai.* first, OpenInference fallback), and batch-inserts " +
		"to ClickHouse `traces` and `observations`. Returns an empty ExportTraceServiceResponse on success.",
	security: [{ basicAuth: [] }],
	request: {
		headers: z.object({
			"x-astraea-project-id": z.string().uuid().openapi({
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

export type OtlpIngestDependencies = {
	defaultClient: typeof defaultClient;
	insertObservations: typeof insertObservations;
	insertTraces: typeof insertTraces;
	publishSync: typeof publishSync;
};

export async function resourceProjectIds(
	req: Request,
): Promise<ReadonlySet<string>> {
	let bodyJson: unknown;
	try {
		bodyJson = await req.clone().json();
	} catch {
		return new Set();
	}

	const parsed = ExportTraceServiceRequest.safeParse(bodyJson);
	if (!parsed.success) return new Set();

	return new Set(
		parsed.data.resource_spans
			.map((resourceSpan) =>
				resourceProjectId(resourceSpan.resource?.attributes ?? []),
			)
			.filter(Boolean),
	);
}

type AggregatedTrace = {
	trace: TenantScopedTrace;
	isRoot: boolean;
};

const productionOtlpIngestDependencies: OtlpIngestDependencies = {
	defaultClient,
	insertObservations,
	insertTraces,
	publishSync,
};

function otlpDeduplicationTokens(request: unknown, tenant: TenantScope) {
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
		traces: `astraea:otlp:traces:${digest}`,
		observations: `astraea:otlp:observations:${digest}`,
	};
}

export function createOtlpIngestHandler(
	dependencies: OtlpIngestDependencies = productionOtlpIngestDependencies,
) {
	return async function handleOtlpIngest(
		req: Request,
		tenant: TenantScope,
		fallbackProjectId = tenant.projectId,
	): Promise<Response> {
		let bodyJson: unknown;
		try {
			bodyJson = await req.json();
		} catch (err) {
			logger.warn("otlp.body_parse_failed", {
				error_type: err instanceof Error ? err.name : typeof err,
			});
			return jsonError(400, "BAD_REQUEST", "Request body is not valid JSON");
		}

		const parsed = ExportTraceServiceRequest.safeParse(bodyJson);
		if (!parsed.success) {
			return jsonError(
				400,
				"BAD_REQUEST",
				`Invalid ExportTraceServiceRequest: ${parsed.error.message}`,
			);
		}

		const request = parsed.data;
		const deduplicationTokens = otlpDeduplicationTokens(request, tenant);
		const redaction = loadRedactionOptions();

		const traces = new Map<string, AggregatedTrace>();
		const observations: TenantScopedObservation[] = [];

		for (const rs of request.resource_spans) {
			const resourceAttributes = rs.resource?.attributes ?? [];
			for (const ss of rs.scope_spans) {
				for (const span of ss.spans) {
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
						return jsonError(
							400,
							"BAD_REQUEST",
							"Trace contains conflicting project provenance",
						);
					}
					trace.input_text = redactTraceText(trace.input_text, redaction);
					trace.output_text = redactTraceText(trace.output_text, redaction);
					observation.input_text = trace.input_text;
					observation.output_text = trace.output_text;
					observation.metadata = redactMetadata(
						observation.metadata,
						redaction,
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

		const client = dependencies.defaultClient();
		try {
			await dependencies.insertTraces(
				client,
				[...traces.values()].map(({ trace }) => trace),
				deduplicationTokens.traces,
			);
			await dependencies.insertObservations(
				client,
				observations,
				deduplicationTokens.observations,
			);
		} catch (err) {
			logger.error("otlp.persist_failed", undefined, {
				error_type: err instanceof Error ? err.name : typeof err,
			});
			return jsonError(
				500,
				"INTERNAL",
				"Failed to persist traces; check server logs",
			);
		}

		try {
			for (const { trace } of traces.values())
				dependencies.publishSync("trace.created", { trace });
			for (const o of observations)
				dependencies.publishSync("observation.created", { observation: o });
		} catch (err) {
			logger.warn("otlp.event_publish_failed", {
				error_type: err instanceof Error ? err.name : typeof err,
			});
		}

		return new Response(JSON.stringify({ partial_success: {} }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
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

function jsonError(code: number, errorCode: string, message: string): Response {
	return new Response(JSON.stringify({ code: errorCode, message }), {
		status: code,
		headers: { "content-type": "application/json" },
	});
}
