import { createRoute } from "@hono/zod-openapi";
import { ErrorEnvelope } from "../schemas/common.js";
import {
	ExportTraceServiceRequest,
	ExportTraceServiceResponse,
} from "../schemas/otlp.js";
import { normalizeSpan } from "../db/gen-ai-attrs.js";
import {
	loadRedactionOptions,
	redactMetadata,
	redactTraceText,
} from "../db/redact.js";
import {
	insertObservations,
	insertTraces,
	defaultClient,
} from "../db/traces-writer.js";
import { publishSync } from "../lib/event-bus.js";

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
			description: "Malformed request body",
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

type AggregatedTrace = {
	trace: ReturnType<typeof normalizeSpan>["trace"];
	isRoot: boolean;
};

const productionOtlpIngestDependencies: OtlpIngestDependencies = {
	defaultClient,
	insertObservations,
	insertTraces,
	publishSync,
};

export function createOtlpIngestHandler(
	dependencies: OtlpIngestDependencies = productionOtlpIngestDependencies,
) {
	return async function handleOtlpIngest(req: Request): Promise<Response> {
		let bodyJson: unknown;
		try {
			bodyJson = await req.json();
		} catch (err) {
			console.error("OTLP body parse failed:", (err as Error).message);
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
		const redaction = loadRedactionOptions();

		const traces = new Map<string, AggregatedTrace>();
		const observations: ReturnType<typeof normalizeSpan>["observation"][] = [];

		for (const rs of request.resource_spans) {
			for (const ss of rs.scope_spans) {
				for (const span of ss.spans) {
					const { trace, observation } = normalizeSpan(span);
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
						aggregateTrace(traces.get(trace.trace_id), trace, isRoot),
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
			);
			await dependencies.insertObservations(client, observations);
		} catch (err) {
			console.error("OTLP insert failed:", (err as Error).message);
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
			console.error(
				"OTLP event publish failed (non-fatal):",
				(err as Error).message,
			);
		}

		return new Response(JSON.stringify({ partial_success: {} }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

function aggregateTrace(
	existing: AggregatedTrace | undefined,
	next: ReturnType<typeof normalizeSpan>["trace"],
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
