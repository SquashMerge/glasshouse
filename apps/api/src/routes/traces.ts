import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { Trace, TraceList, TraceStubResponses, Observation, ObservationList } from "../schemas/traces.js";
import { TraceIdParam } from "../schemas/common.js";
import {
  defaultClient,
  getTrace as queryGetTrace,
  listTraces as queryListTraces,
  listObservations as queryListObservations,
} from "../db/traces-query.js";
import {
  presentObservationMetadata,
  type ObservationMetadata,
} from "../db/observation-metadata.js";

function presentObservation<T extends { type: string; metadata: string | ObservationMetadata }>(observation: T) {
  return {
    ...observation,
    metadata: presentObservationMetadata(observation.metadata, observation.type === "generation"),
  };
}

export const listTraces = createRoute({
  method: "get",
  path: "/v1/traces",
  tags: ["traces"],
  summary: "List traces",
  description: "Returns up to 50 traces sorted by start_time DESC. Each row's input_text is truncated to 200 chars.",
  security: [{ basicAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: TraceList } } },
    ...TraceStubResponses,
  },
});

export async function handleListTraces(c: Context): Promise<Response> {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
  const q = c.req.query("filter[q]");
  const filters = {
    project_id: c.req.query("filter[project_id]") ?? undefined,
    agent_id: c.req.query("filter[agent_id]") ?? undefined,
    env: c.req.query("filter[env]") ?? undefined,
    time_from: c.req.query("filter[time.from]") ?? undefined,
    time_to: c.req.query("filter[time.to]") ?? undefined,
    name: c.req.query("filter[name]") ?? undefined,
    status: c.req.query("filter[status]") ?? undefined,
    duration: c.req.query("filter[duration]") ?? undefined,
    scores: c.req.query("filter[scores]") ?? undefined,
    input_text: q ?? c.req.query("filter[input_text]") ?? undefined,
  };
  try {
    const { items, total } = await queryListTraces(defaultClient(), filters, limit, offset);
    return c.json({ items, total });
  } catch (err) {
    console.error("GET /v1/traces failed:", (err as Error).message);
    return c.json({ code: "INTERNAL", message: "Query failed; check server logs" }, 500);
  }
}

export const getTrace = createRoute({
  method: "get",
  path: "/v1/traces/{id}",
  tags: ["traces"],
  summary: "Get a trace",
  description:
    "Fetch a trace and its observations with versioned metadata envelopes. Legacy metadata arrays are exposed as attributes with null prompt provenance; invalid persisted metadata fails closed.",
  security: [{ basicAuth: [] }],
  request: {
    params: TraceIdParam,
    query: z.object({
      expand: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            trace: Trace,
            observations: z.array(Observation),
          }),
        },
      },
    },
    404: {
      description: "Trace not found",
      content: { "application/json": { schema: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } },
    },
  },
});

export async function handleGetTrace(c: Context): Promise<Response> {
  const traceId = c.req.param("id");
  try {
    const { trace, observations } = await queryGetTrace(defaultClient(), traceId);
    if (!trace) {
      return c.json({ code: "NOT_FOUND", message: `Trace ${traceId} not found` }, 404);
    }
    return c.json({ trace, observations: observations.map(presentObservation) });
  } catch (err) {
    console.error("GET /v1/traces/{id} failed:", (err as Error).message);
    return c.json({ code: "INTERNAL", message: "Query failed; check server logs" }, 500);
  }
}

export const listObservations = createRoute({
  method: "get",
  path: "/v1/observations",
  tags: ["traces"],
  summary: "List observations (spans)",
  description: "Returns up to 50 observations per page sorted by start_time DESC. input_text is truncated to 200 chars.",
  security: [{ basicAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ObservationList } } },
    ...TraceStubResponses,
  },
});

export async function handleListObservations(c: Context): Promise<Response> {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
  const filters = {
    project_id: c.req.query("filter[project_id]") ?? undefined,
    agent_id: c.req.query("filter[agent_id]") ?? undefined,
    trace_id: c.req.query("filter[trace_id]") ?? undefined,
    type: c.req.query("filter[type]") ?? undefined,
    time_from: c.req.query("filter[time.from]") ?? undefined,
    time_to: c.req.query("filter[time.to]") ?? undefined,
    name: c.req.query("filter[name]") ?? undefined,
    status: c.req.query("filter[status]") ?? undefined,
    duration: c.req.query("filter[duration]") ?? undefined,
    model: c.req.query("filter[model]") ?? undefined,
    input_text: c.req.query("filter[input_text]") ?? undefined,
  };
  try {
    const { items, total } = await queryListObservations(defaultClient(), filters, limit, offset);
    return c.json({ items: items.map(presentObservation), total });
  } catch (err) {
    console.error("GET /v1/observations failed:", (err as Error).message);
    return c.json({ code: "INTERNAL", message: "Query failed; check server logs" }, 500);
  }
}
