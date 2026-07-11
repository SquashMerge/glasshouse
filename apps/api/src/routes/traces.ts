// Real implementations of /v1/traces, /v1/traces/{id}, /v1/traces/search.
// Backed by ClickHouse via apps/api/src/db/traces-query.ts.

import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { Trace, TraceList, TraceSearchQuery, TraceStubResponses } from "../schemas/traces.js";
import { IdParam } from "../schemas/common.js";
import { defaultClient, getTrace, listTraces, searchTraces } from "../db/traces-query.js";

// GET /v1/traces
export const listTracesRoute = createRoute({
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
  const filters = {
    project_id: c.req.query("filter[project_id]") ?? undefined,
    agent_id: c.req.query("filter[agent_id]") ?? undefined,
    env: c.req.query("filter[env]") ?? undefined,
    time_from: c.req.query("filter[time.from]") ?? undefined,
    time_to: c.req.query("filter[time.to]") ?? undefined,
  };
  const { items, total } = await listTraces(defaultClient(), filters, limit, offset);
  return c.json({ items, total });
}

// GET /v1/traces/{id}
export const getTraceRoute = createRoute({
  method: "get",
  path: "/v1/traces/{id}",
  tags: ["traces"],
  summary: "Get a trace",
  security: [{ basicAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              trace: { $ref: "#/components/schemas/Trace" },
              observations: { type: "array", items: { $ref: "#/components/schemas/Observation" } },
            },
            required: ["trace", "observations"],
          },
        },
      },
    },
    404: { description: "Trace not found", content: { "application/json": { schema: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } } },
  },
});

export async function handleGetTrace(c: Context): Promise<Response> {
  const traceId = c.req.valid("param").id as string;
  const { trace, observations } = await getTrace(defaultClient(), traceId);
  if (!trace) {
    return c.json({ code: "NOT_FOUND", message: `Trace ${traceId} not found` }, 404);
  }
  return c.json({ trace, observations });
}

// GET /v1/traces/search
export const searchTracesRoute = createRoute({
  method: "get",
  path: "/v1/traces/search",
  tags: ["traces"],
  summary: "Search traces",
  description: "Full-text search via tokenbf_v1 indexes; <50ms p95 filtered / <100ms p95 full-text on the seeded dataset.",
  security: [{ basicAuth: [] }],
  request: { query: TraceSearchQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: TraceList } } },
    ...TraceStubResponses,
  },
});

export async function handleSearchTraces(c: Context): Promise<Response> {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
  const q = {
    q: c.req.query("q") ?? undefined,
    project_id: c.req.query("filter[project_id]") ?? undefined,
    agent_id: c.req.query("filter[agent_id]") ?? undefined,
    env: c.req.query("filter[env]") ?? undefined,
    time_from: c.req.query("filter[time.from]") ?? undefined,
    time_to: c.req.query("filter[time.to]") ?? undefined,
    sort: c.req.query("sort") ?? "start_time:desc",
  };
  const { items, total } = await searchTraces(defaultClient(), q, limit, offset);
  return c.json({ items, total });
}