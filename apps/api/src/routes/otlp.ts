import { createRoute } from "@hono/zod-openapi";
import { ErrorEnvelope } from "../schemas/common.js";
import {
  ExportTraceServiceRequest,
  ExportTraceServiceResponse,
} from "../schemas/otlp.js";
import { normalizeSpan } from "../db/gen-ai-attrs.js";
import { loadRedactionOptions, redactAttributesJson, redactTraceText } from "../db/redact.js";
import { insertObservations, insertTraces, defaultClient } from "../db/traces-writer.js";
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

export async function handleOtlpIngest(req: Request): Promise<Response> {
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch (err) {
    console.error("OTLP body parse failed:", (err as Error).message);
    return jsonError(400, "BAD_REQUEST", "Request body is not valid JSON");
  }

  const parsed = ExportTraceServiceRequest.safeParse(bodyJson);
  if (!parsed.success) {
    return jsonError(400, "BAD_REQUEST", `Invalid ExportTraceServiceRequest: ${parsed.error.message}`);
  }

  const request = parsed.data;
  const redaction = loadRedactionOptions();

  const traces = new Map<string, ReturnType<typeof normalizeSpan>["trace"]>();
  const observations: ReturnType<typeof normalizeSpan>["observation"][] = [];

  for (const rs of request.resource_spans) {
    for (const ss of rs.scope_spans) {
      for (const span of ss.spans) {
        const { trace, observation } = normalizeSpan(span);
        trace.input_text = redactTraceText(trace.input_text, redaction);
        trace.output_text = redactTraceText(trace.output_text, redaction);
        observation.input_text = trace.input_text;
        observation.output_text = trace.output_text;
        observation.metadata = redactAttributesJson(observation.metadata, redaction);
        traces.set(trace.trace_id, trace);
        observations.push(observation);
      }
    }
  }

  const client = defaultClient();
  try {
    await insertTraces(client, [...traces.values()]);
    await insertObservations(client, observations);
  } catch (err) {
    console.error("OTLP insert failed:", (err as Error).message);
    return jsonError(500, "INTERNAL", "Failed to persist traces; check server logs");
  }

  // Fan out to the in-process bus (and Valkey if configured). publishSync
  // catches its own errors so a subscriber crash can't 500 the ingest path.
  try {
    for (const t of [...traces.values()]) publishSync("trace.created", { trace: t });
    for (const o of observations) publishSync("observation.created", { observation: o });
  } catch (err) {
    console.error("OTLP event publish failed (non-fatal):", (err as Error).message);
  }

  return new Response(JSON.stringify({ partial_success: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(code: number, errorCode: string, message: string): Response {
  return new Response(JSON.stringify({ code: errorCode, message }), {
    status: code,
    headers: { "content-type": "application/json" },
  });
}