import { z } from "@hono/zod-openapi";
import {
  MAX_PROMPT_SOURCE_CHARS,
  MAX_PROMPT_SOURCE_LINES,
  hasAtMostLines,
  renderDataBudgetError,
} from "../lib/prompt-limits.js";
import { ErrorEnvelope } from "./common.js";

export const PromptId = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).openapi({
  example: "support-agent",
});

export const PromptIdParam = z.object({
  id: PromptId.openapi({ param: { name: "id", in: "path" } }),
}).strict();

export const ProjectIdQuery = z.object({
  project_id: z.string().uuid().openapi({ param: { name: "project_id", in: "query" } }),
}).strict();

export const PromptVersionQuery = ProjectIdQuery.extend({
  version: z.coerce.number().int().positive().optional().openapi({ param: { name: "version", in: "query" } }),
}).strict();

export const JsonObject = z.record(z.unknown()).openapi({ example: { temperature: 0.2 } });
export const PromptSource = z.string()
  .max(MAX_PROMPT_SOURCE_CHARS)
  .refine((value) => hasAtMostLines(value, MAX_PROMPT_SOURCE_LINES), `Must contain at most ${MAX_PROMPT_SOURCE_LINES} lines`);

export const PromptMessage = z.object({
  role: z.enum(["system", "user"]),
  content: PromptSource,
}).strict().openapi("PromptMessage");

export const PromptMessages = z.array(PromptMessage).min(1).max(2).superRefine((messages, context) => {
  if (new Set(messages.map((message) => message.role)).size !== messages.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each prompt may contain at most one system and one user message" });
  }
});

export const PromptVersion = z.object({
  id: PromptId,
  version: z.number().int().positive(),
  messages: PromptMessages,
  model: z.string().nullable(),
  settings: JsonObject,
  change_summary: z.string().min(1),
  created_by: z.string().min(1),
  created_at: z.string().datetime(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  diff: z.string().nullable(),
}).strict().openapi("PromptVersion");

export const Prompt = PromptVersion.extend({
  project_id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
}).strict().openapi("Prompt");

export const PromptCreate = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  messages: PromptMessages,
  model: z.string().nullable().optional(),
  settings: JsonObject.optional(),
  change_summary: z.string().trim().min(1).optional(),
}).strict().openapi("PromptCreate");

export const PromptVersionCreate = z.object({
  base_version: z.number().int().positive(),
  messages: PromptMessages,
  model: z.string().nullable().optional(),
  settings: JsonObject.optional(),
  change_summary: z.string().trim().min(1),
}).strict().openapi("PromptVersionCreate");

export const PromptRender = z.object({
  data: JsonObject.superRefine((value, context) => {
    const budgetError = renderDataBudgetError(value);
    if (budgetError) context.addIssue({ code: z.ZodIssueCode.custom, message: budgetError });
  }),
}).strict().openapi("PromptRender");

export const PromptRenderResponse = z.object({
  id: PromptId,
  version: z.number().int().positive(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  messages: PromptMessages,
  warnings: z.array(z.object({
    code: z.literal("MISSING_VARIABLE"),
    role: z.enum(["system", "user"]),
    path: z.string().min(1),
  }).strict()),
}).strict().openapi("PromptRenderResponse");

export const PromptDelete = z.object({
  confirmation: PromptId,
}).strict().openapi("PromptDelete");

export const PromptProvenanceQuery = ProjectIdQuery.extend({
  version: z.coerce.number().int().positive().openapi({ param: { name: "version", in: "query" } }),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/).openapi({ param: { name: "content_hash", in: "query" } }),
}).strict();

export const PromptProvenanceStatus = z.object({
  status: z.enum(["active", "deleted", "unknown"]),
}).strict().openapi("PromptProvenanceStatus");

export const PromptErrorResponses = {
  400: { description: "Bad request", content: { "application/json": { schema: ErrorEnvelope } } },
  404: { description: "Not found", content: { "application/json": { schema: ErrorEnvelope } } },
  409: { description: "Conflict", content: { "application/json": { schema: ErrorEnvelope } } },
  500: { description: "Internal error", content: { "application/json": { schema: ErrorEnvelope } } },
};
