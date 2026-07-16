import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";

export const CustomerCredentialScope = z.enum(["prompts:read", "prompts:render", "prompts:write"]);
export const CustomerCredential = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  display_name: z.string(),
  prefix: z.string(),
  fingerprint: z.string(),
  scopes: z.array(CustomerCredentialScope).min(1),
  created_by: z.string(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(),
  revoked_at: z.string().datetime().nullable(),
  last_used_at: z.string().datetime().nullable(),
}).strict().openapi("CustomerCredential");

export const CustomerCredentialCreate = z.object({
  project_id: z.string().uuid(),
  display_name: z.string().trim().min(1).max(255),
  scopes: z.array(CustomerCredentialScope).min(1),
  expires_at: z.string().datetime().nullable().optional(),
}).strict().openapi("CustomerCredentialCreate");

export const CustomerCredentialCreateResponse = CustomerCredential.extend({
  secret: z.string().min(1).openapi({ description: "Shown only by this creation response. Store it securely; it cannot be retrieved again." }),
}).strict().openapi("CustomerCredentialCreateResponse");

export const CustomerCredentialIdParam = z.object({
  id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }),
}).strict();

export const CustomerCredentialProjectQuery = z.object({
  project_id: z.string().uuid().openapi({ param: { name: "project_id", in: "query" } }),
}).strict();

export const CustomerCredentialList = z.object({ items: z.array(CustomerCredential) }).strict().openapi("CustomerCredentialList");

export const CustomerCredentialErrorResponses = {
  400: { description: "Bad request", content: { "application/json": { schema: ErrorEnvelope } } },
  401: { description: "Unauthorized", content: { "application/json": { schema: ErrorEnvelope } } },
  403: { description: "Forbidden", content: { "application/json": { schema: ErrorEnvelope } } },
  404: { description: "Not found", content: { "application/json": { schema: ErrorEnvelope } } },
  409: { description: "Conflict", content: { "application/json": { schema: ErrorEnvelope } } },
  500: { description: "Internal error", content: { "application/json": { schema: ErrorEnvelope } } },
};
