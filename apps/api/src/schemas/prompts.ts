import { z } from "@hono/zod-openapi";
import { ErrorEnvelope, NotImplementedError } from "./common.js";

export const Prompt = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable().optional(),
  current_version: z.number().int().nullable().optional(),
  labels: z.record(z.string()).openapi({
    description: "Map of label -> version_id (e.g. { 'production': 'uuid' }).",
    example: { production: "550e8400-e29b-41d4-a716-446655440099" },
  }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).openapi("Prompt");

export const PromptCreate = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  initial_content: z.string(),
  initial_model: z.string().nullable().optional(),
}).openapi("PromptCreate");

export const PromptVersion = z.object({
  id: z.string().uuid(),
  prompt_id: z.string().uuid(),
  version: z.number().int(),
  content: z.string(),
  model: z.string().nullable().optional(),
  metadata: z.record(z.unknown()),
  created_at: z.string().datetime(),
}).openapi("PromptVersion");

export const PromptLabelPatch = z.object({
  label: z.string(),
  version_id: z.string().uuid(),
}).openapi("PromptLabelPatch");

export const PromptStubResponses = {
  501: { description: "Not implemented", content: { "application/json": { schema: NotImplementedError } } },
  400: { description: "Bad request", content: { "application/json": { schema: ErrorEnvelope } } },
  404: { description: "Prompt not found", content: { "application/json": { schema: ErrorEnvelope } } },
};