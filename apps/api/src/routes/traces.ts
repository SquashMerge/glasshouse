import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { Trace, TraceList, TraceSearchQuery, TraceStubResponses } from "../schemas/traces.js";
import { IdParam } from "../schemas/common.js";
import { defaultClient, getTrace as queryGetTrace, listTraces as queryListTraces, searchTraces as querySearchTraces } from "../db/traces-query.js";

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
    404: {
      description: "Trace not found",
      content: { "application/json": { schema: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } },
    },
  },
});

export async function handleGetTrace(c: Context): Promise<Response> {
  const traceId = c.req.valid("param").id as string;
  try {
    const { trace, observations } = await queryGetTrace(defaultClient(), traceId);
    if (!trace) {
      return c.json({ code: "NOT_FOUND", message: `Trace ${traceId} not found` }, 404);
    }
    return c.json({ trace, observations });
  } catch (err) {
    console.error("GET /v1/traces/{id} failed:", (err as Error).message);
    return c.json({ code: "INTERNAL", message: "Query failed; check server logs" }, 500);
  }
}

export const searchTraces = createRoute({
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
  try {
    const { items, total } = await querySearchTraces(defaultClient(), q, limit, offset);
    return c.json({ items, total });
  } catch (err) {
    console.error("GET /v1/traces/search failed:", (err as Error).message);
    return c.json({ code: "INTERNAL", message: "Query failed; check server logs" }, 500);
  }
}