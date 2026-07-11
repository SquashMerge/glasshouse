import { z } from "@hono/zod-openapi";
import { ErrorEnvelope, NotImplementedError } from "./common.js";

export const ExperimentStatus = z.enum(["pending", "running", "completed", "failed", "cancelled"]).openapi("ExperimentStatus");

export const Experiment = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  dataset_id: z.string().uuid(),
  name: z.string().nullable().optional(),
  status: ExperimentStatus,
  config: z.record(z.unknown()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).openapi("Experiment");

export const ExperimentCreate = Experiment.pick({
  project_id: true,
  agent_id: true,
  dataset_id: true,
  name: true,
  config: true,
}).openapi("ExperimentCreate");

export const ExperimentList = z.object({
  items: z.array(Experiment),
  total: z.number().int(),
}).openapi("ExperimentList");

export const ExperimentResults = z.object({
  experiment_id: z.string().uuid(),
  items: z.array(z.object({
    dataset_item_id: z.string().uuid(),
    agent_version: z.string().nullable().optional(),
    output: z.unknown().nullable().optional(),
    scores: z.record(z.number()),
    duration_ms: z.number().int().nullable().optional(),
    status: ExperimentStatus,
  })),
}).openapi("ExperimentResults");

export const ExperimentSummary = z.object({
  experiment_id: z.string().uuid(),
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  pass_rate: z.number().min(0).max(1),
  avg_duration_ms: z.number().nullable().optional(),
}).openapi("ExperimentSummary");

export const ExperimentStubResponses = {
  501: { description: "Not implemented", content: { "application/json": { schema: NotImplementedError } } },
  400: { description: "Bad request", content: { "application/json": { schema: ErrorEnvelope } } },
  404: { description: "Experiment not found", content: { "application/json": { schema: ErrorEnvelope } } },
};