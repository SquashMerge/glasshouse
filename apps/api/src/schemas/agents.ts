import { z } from "@hono/zod-openapi";
import { ErrorEnvelope, NotImplementedError } from "./common.js";

export const AgentEnv = z.enum(["development", "staging", "production"]).openapi("AgentEnv");

export const Agent = z.object({
  id: z.string().uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  project_id: z.string().uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440001" }),
  name: z.string().min(1).max(120).openapi({ example: "research-assistant" }),
  description: z.string().nullable().optional().openapi({ example: "Answers research questions with citations." }),
  framework: z.string().nullable().optional().openapi({ example: "agno" }),
  framework_version: z.string().nullable().optional().openapi({ example: "2.6.22" }),
  manifest: z.record(z.unknown()).openapi({ example: { model: { provider: "openai", name: "gpt-4o" } } }),
  current_version: z.string().nullable().optional().openapi({ example: "v3" }),
  env: AgentEnv,
  created_at: z.string().datetime().openapi({ example: "2026-07-11T18:00:00Z" }),
  updated_at: z.string().datetime().openapi({ example: "2026-07-11T18:00:00Z" }),
}).openapi("Agent");

export const AgentCreate = Agent.pick({
  project_id: true,
  name: true,
  description: true,
  framework: true,
  framework_version: true,
  manifest: true,
  env: true,
}).openapi("AgentCreate");

export const AgentPatch = AgentCreate.partial().openapi("AgentPatch");

export const AgentList = z.object({
  items: z.array(Agent),
  total: z.number().int().openapi({ example: 42 }),
}).openapi("AgentList");

// Stub response shared by all 8 agent routes
export const AgentStubResponses = {
  501: {
    description: "Not implemented",
    content: { "application/json": { schema: NotImplementedError } },
  },
  400: { description: "Bad request", content: { "application/json": { schema: ErrorEnvelope } } },
  404: { description: "Agent not found", content: { "application/json": { schema: ErrorEnvelope } } },
};