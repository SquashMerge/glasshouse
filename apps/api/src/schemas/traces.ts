import { z } from "@hono/zod-openapi";
import { ErrorEnvelope, NotImplementedError } from "./common.js";

export const TraceStatus = z.enum(["ok", "error"]).openapi("TraceStatus");

export const Trace = z.object({
  trace_id: z.string(),
  project_id: z.string(),
  name: z.string(),
  start_time: z.string().datetime(),
  end_time: z.string().datetime().nullable().optional(),
  duration_ms: z.number().int().nullable().optional(),
  status: TraceStatus,
  user_id: z.string().default(""),
  session_id: z.string().default(""),
  agent_id: z.string().default(""),
  agent_version: z.string().default(""),
  env: z.string(),
  tags: z.array(z.string()).default([]),
  input_text: z.string().default(""),
  output_text: z.string().default(""),
}).openapi("Trace");

export const TraceList = z.object({
  items: z.array(Trace),
  total: z.number().int(),
}).openapi("TraceList");

export const TraceSearchQuery = z.object({
  q: z.string().optional(),
  "filter[project_id]": z.string().optional(),
  "filter[agent_id]": z.string().optional(),
  "filter[env]": z.string().optional(),
  "filter[time.from]": z.string().datetime().optional(),
  "filter[time.to]": z.string().datetime().optional(),
  sort: z.string().optional().default("start_time:desc"),
  expand: z.string().optional(),
}).openapi("TraceSearchQuery");

export const Observation = z.object({
  observation_id: z.string(),
  trace_id: z.string(),
  parent_observation_id: z.string().nullable().optional(),
  type: z.enum(["span", "event", "generation", "tool"]),
  name: z.string(),
  start_time: z.string().datetime(),
  end_time: z.string().datetime().nullable().optional(),
  duration_ms: z.number().int().nullable().optional(),
  status: TraceStatus,
  model: z.string().nullable().optional(),
  input_text: z.string().default(""),
  output_text: z.string().default(""),
}).openapi("Observation");

export const ObservationList = z.object({
  items: z.array(Observation),
  total: z.number().int(),
}).openapi("ObservationList");

export const TraceStubResponses = {
  501: { description: "Not implemented", content: { "application/json": { schema: NotImplementedError } } },
  404: { description: "Trace not found", content: { "application/json": { schema: ErrorEnvelope } } },
};