import { z } from "@hono/zod-openapi";
import { ErrorEnvelope, NotImplementedError } from "./common.js";

export const Dataset = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable().optional(),
  item_count: z.number().int().openapi({ example: 100 }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).openapi("Dataset");

export const DatasetCreate = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
}).openapi("DatasetCreate");

export const DatasetItem = z.object({
  id: z.string().uuid(),
  dataset_id: z.string().uuid(),
  input: z.record(z.unknown()),
  expected_output: z.record(z.unknown()).nullable().optional(),
  metadata: z.record(z.unknown()),
  created_at: z.string().datetime(),
}).openapi("DatasetItem");

export const DatasetItemCreate = z.object({
  input: z.record(z.unknown()),
  expected_output: z.record(z.unknown()).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
}).openapi("DatasetItemCreate");

export const DatasetStubResponses = {
  501: { description: "Not implemented", content: { "application/json": { schema: NotImplementedError } } },
  400: { description: "Bad request", content: { "application/json": { schema: ErrorEnvelope } } },
  404: { description: "Dataset not found", content: { "application/json": { schema: ErrorEnvelope } } },
};