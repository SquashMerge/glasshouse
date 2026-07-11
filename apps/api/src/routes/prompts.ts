import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { Prompt, PromptCreate, PromptVersion, PromptLabelPatch, PromptStubResponses } from "../schemas/prompts.js";
import { IdParam } from "../schemas/common.js";
import { notImplemented } from "./_stub.js";

const tag = "prompts";

export const listPrompts = createRoute({
  method: "get",
  path: "/v1/prompts",
  tags: [tag],
  summary: "List prompts",
  responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ items: z.array(Prompt), total: z.number().int() }) } } }, ...PromptStubResponses },
});
export const handleListPrompts = () => notImplemented();

export const createPrompt = createRoute({
  method: "post",
  path: "/v1/prompts",
  tags: [tag],
  summary: "Create a prompt",
  request: { body: { content: { "application/json": { schema: PromptCreate } } } },
  responses: { 201: { description: "Prompt created", content: { "application/json": { schema: Prompt } } }, ...PromptStubResponses },
});
export const handleCreatePrompt = () => notImplemented();

export const getPrompt = createRoute({
  method: "get",
  path: "/v1/prompts/{id}",
  tags: [tag],
  summary: "Get a prompt",
  request: { params: IdParam },
  responses: { 200: { description: "OK", content: { "application/json": { schema: Prompt } } }, ...PromptStubResponses },
});
export const handleGetPrompt = (_id: string) => notImplemented();

export const listPromptVersions = createRoute({
  method: "get",
  path: "/v1/prompts/{id}/versions",
  tags: [tag],
  summary: "List prompt versions",
  request: { params: IdParam },
  responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ items: z.array(PromptVersion) }) } } }, ...PromptStubResponses },
});
export const handleListPromptVersions = (_id: string) => notImplemented();

export const createPromptVersion = createRoute({
  method: "post",
  path: "/v1/prompts/{id}/versions",
  tags: [tag],
  summary: "Create a new prompt version",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({ content: z.string(), model: z.string().nullable().optional() }) } } } },
  responses: { 201: { description: "Version created", content: { "application/json": { schema: PromptVersion } } }, ...PromptStubResponses },
});
export const handleCreatePromptVersion = (_id: string) => notImplemented();

export const patchPromptLabels = createRoute({
  method: "patch",
  path: "/v1/prompts/{id}/labels",
  tags: [tag],
  summary: "Set a prompt label",
  request: { params: IdParam, body: { content: { "application/json": { schema: PromptLabelPatch } } } },
  responses: { 200: { description: "OK", content: { "application/json": { schema: Prompt } } }, ...PromptStubResponses },
});
export const handlePatchPromptLabels = (_id: string) => notImplemented();