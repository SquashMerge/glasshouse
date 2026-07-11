import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { Trace, TraceList, TraceSearchQuery, Observation, TraceStubResponses } from "../schemas/traces.js";
import { IdParam } from "../schemas/common.js";
import { notImplemented } from "./_stub.js";

const tag = "traces";

export const listTraces = createRoute({
  method: "get",
  path: "/v1/traces",
  tags: [tag],
  summary: "List traces",
  responses: { 200: { description: "OK", content: { "application/json": { schema: TraceList } } }, ...TraceStubResponses },
});
export const handleListTraces = () => notImplemented();

export const getTrace = createRoute({
  method: "get",
  path: "/v1/traces/{id}",
  tags: [tag],
  summary: "Get a trace",
  request: { params: IdParam },
  responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ trace: Trace, observations: z.array(Observation) }) } } }, ...TraceStubResponses },
});
export const handleGetTrace = (_id: string) => notImplemented();

export const searchTraces = createRoute({
  method: "get",
  path: "/v1/traces/search",
  tags: [tag],
  summary: "Search traces",
  request: { query: TraceSearchQuery },
  responses: { 200: { description: "OK", content: { "application/json": { schema: TraceList } } }, ...TraceStubResponses },
});
export const handleSearchTraces = () => notImplemented();