// OTLP HTTP/JSON receiver at /v1/otel/v1/traces.
// Accepts ExportTraceServiceRequest, validates with Zod, normalizes each span
// (gen_ai.* + OpenInference), batch-inserts to ClickHouse, returns empty success.

import { createRoute } from "@hono/zod-openapi";
import { ErrorEnvelope } from "../schemas/common.js";
import {
  ExportTraceServiceRequest,
  ExportTraceServiceResponse,
} from "../schemas/otlp.js";
import { normalizeSpan } from "../db/gen-ai-attrs.js";
import { insertObservations, insertTraces, defaultClient } from "../db/traces-writer.js";

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
  // Parse + validate body.
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return jsonError(400, "BAD_REQUEST", "Request body is not valid JSON");
  }

  const parsed = ExportTraceServiceRequest.safeParse(bodyJson);
  if (!parsed.success) {
    return jsonError(400, "BAD_REQUEST", `Invalid ExportTraceServiceRequest: ${parsed.error.message}`);
  }

  const request = parsed.data;

  // Flatten spans and normalize.
  const traces = new Map<string, ReturnType<typeof normalizeSpan>["trace"]>();
  const observations: ReturnType<typeof normalizeSpan>["observation"][] = [];

  for (const rs of request.resource_spans) {
    for (const ss of rs.scope_spans) {
      for (const span of ss.spans) {
        const { trace, observation } = normalizeSpan(span);
        // Last write wins for trace metadata (one trace row per trace_id).
        traces.set(trace.trace_id, trace);
        observations.push(observation);
      }
    }
  }

  // Batch insert.
  const client = defaultClient();
  try {
    await insertTraces(client, [...traces.values()]);
    await insertObservations(client, observations);
  } catch (err) {
    return jsonError(500, "INTERNAL", `ClickHouse insert failed: ${(err as Error).message}`);
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