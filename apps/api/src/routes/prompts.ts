import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  createPrompt as createPromptRecord,
  createPromptVersion as createPromptVersionRecord,
  deletePrompt as deletePromptRecord,
  getPrompt as getPromptRecord,
  listPromptVersions as listPromptVersionsRecord,
  listPrompts as listPromptsRecord,
  PromptRepositoryError,
  renderPrompt as renderPromptRecord,
} from "../db/prompts.js";
import type { JsonObject } from "../db/prompts.js";
import { pgPool } from "../db/postgres.js";
import { renderPromptTemplatesWithWarnings } from "../lib/prompt-templates.js";
import { TRUSTED_ACTOR_CONTEXT_KEY } from "../middleware/auth.js";
import {
  Prompt,
  PromptCreate,
  PromptDelete,
  PromptErrorResponses,
  PromptIdParam,
  PromptPreview,
  PromptPreviewResponse,
  PromptRender,
  PromptRenderResponse,
  PromptVersion,
  PromptVersionCreate,
  PromptVersionQuery,
  ProjectIdQuery,
} from "../schemas/prompts.js";

const tag = "prompts";

const PromptList = z.object({ items: z.array(Prompt), total: z.number().int().nonnegative() }).strict();
const PromptVersionList = z.object({ items: z.array(PromptVersion) }).strict();

function actor(c: Context): string {
  const value = c.get(TRUSTED_ACTOR_CONTEXT_KEY);
  if (typeof value !== "string") throw new PromptRepositoryError("INTERNAL", "Trusted actor is unavailable");
  return value;
}

function failure(c: Context, cause: unknown): Response {
  const known = cause instanceof PromptRepositoryError
    ? cause
    : new PromptRepositoryError("INTERNAL", "Prompt operation failed", cause);
  return c.json({ code: known.code, message: known.code === "INTERNAL" ? "Prompt operation failed" : known.message }, known.status);
}

export type PromptRouteDependencies = {
  pool: typeof pgPool;
  createPrompt: typeof createPromptRecord;
  createPromptVersion: typeof createPromptVersionRecord;
  deletePrompt: typeof deletePromptRecord;
  getPrompt: typeof getPromptRecord;
  listPromptVersions: typeof listPromptVersionsRecord;
  listPrompts: typeof listPromptsRecord;
  renderPrompt: typeof renderPromptRecord;
};

const productionPromptRouteDependencies: PromptRouteDependencies = {
  pool: pgPool,
  createPrompt: createPromptRecord,
  createPromptVersion: createPromptVersionRecord,
  deletePrompt: deletePromptRecord,
  getPrompt: getPromptRecord,
  listPromptVersions: listPromptVersionsRecord,
  listPrompts: listPromptsRecord,
  renderPrompt: renderPromptRecord,
};

export const listPrompts = createRoute({
  method: "get",
  path: "/v1/prompts",
  tags: [tag],
  summary: "List project prompts",
  security: [{ basicAuth: [] }],
  request: { query: ProjectIdQuery },
  responses: { 200: { description: "OK", content: { "application/json": { schema: PromptList } } }, ...PromptErrorResponses },
});

export const createPrompt = createRoute({
  method: "post",
  path: "/v1/prompts",
  tags: [tag],
  summary: "Create a project prompt and version one",
  security: [{ basicAuth: [] }],
  request: { body: { content: { "application/json": { schema: PromptCreate } } } },
  responses: { 201: { description: "Prompt created", content: { "application/json": { schema: Prompt } } }, ...PromptErrorResponses },
});

export const getPrompt = createRoute({
  method: "get",
  path: "/v1/prompts/{id}",
  tags: [tag],
  summary: "Get a project prompt version",
  security: [{ basicAuth: [] }],
  request: { params: PromptIdParam, query: PromptVersionQuery },
  responses: { 200: { description: "OK", content: { "application/json": { schema: Prompt } } }, ...PromptErrorResponses },
});

export const listPromptVersions = createRoute({
  method: "get",
  path: "/v1/prompts/{id}/versions",
  tags: [tag],
  summary: "List immutable prompt versions",
  security: [{ basicAuth: [] }],
  request: { params: PromptIdParam, query: ProjectIdQuery },
  responses: { 200: { description: "OK", content: { "application/json": { schema: PromptVersionList } } }, ...PromptErrorResponses },
});

export const createPromptVersion = createRoute({
  method: "post",
  path: "/v1/prompts/{id}/versions",
  tags: [tag],
  summary: "Create the next immutable prompt version",
  security: [{ basicAuth: [] }],
  request: { params: PromptIdParam, query: ProjectIdQuery, body: { content: { "application/json": { schema: PromptVersionCreate } } } },
  responses: { 201: { description: "Version created", content: { "application/json": { schema: PromptVersion } } }, ...PromptErrorResponses },
});

export const renderPrompt = createRoute({
  method: "post",
  path: "/v1/prompts/{id}/render",
  tags: [tag],
  summary: "Render a prompt version as plain LLM text",
  security: [{ basicAuth: [] }],
  request: { params: PromptIdParam, query: PromptVersionQuery, body: { content: { "application/json": { schema: PromptRender } } } },
  responses: { 200: { description: "Rendered", content: { "application/json": { schema: PromptRenderResponse } } }, ...PromptErrorResponses },
});

export const previewPrompt = createRoute({
  method: "post",
  path: "/v1/prompts/preview",
  tags: [tag],
  summary: "Render unsaved system and user prompt drafts as plain LLM text",
  security: [{ basicAuth: [] }],
  request: { body: { content: { "application/json": { schema: PromptPreview } } } },
  responses: { 200: { description: "Rendered", content: { "application/json": { schema: PromptPreviewResponse } } }, ...PromptErrorResponses },
});

export const deletePrompt = createRoute({
  method: "delete",
  path: "/v1/prompts/{id}",
  tags: [tag],
  summary: "Hard-delete a prompt and permanently reserve its identifier",
  security: [{ basicAuth: [] }],
  request: { params: PromptIdParam, query: ProjectIdQuery, body: { content: { "application/json": { schema: PromptDelete } } } },
  responses: { 204: { description: "Deleted" }, ...PromptErrorResponses },
});

export function createPromptRouteHandlers(dependencies: PromptRouteDependencies = productionPromptRouteDependencies) {
  return {
    handleListPrompts: async (c: Parameters<RouteHandler<typeof listPrompts>>[0]): Promise<Response> => {
      try {
        const query = c.req.valid("query") as { project_id: string };
        return c.json(await dependencies.listPrompts(dependencies.pool(), query.project_id));
      } catch (cause) {
        return failure(c, cause);
      }
    },
    handleCreatePrompt: async (c: Parameters<RouteHandler<typeof createPrompt>>[0]): Promise<Response> => {
      try {
        const body = c.req.valid("json") as Omit<Parameters<typeof createPromptRecord>[1], "actor">;
        return c.json(await dependencies.createPrompt(dependencies.pool(), { ...body, actor: actor(c) }), 201);
      } catch (cause) {
        return failure(c, cause);
      }
    },
    handleGetPrompt: async (c: Parameters<RouteHandler<typeof getPrompt>>[0]): Promise<Response> => {
      try {
        const params = c.req.valid("param") as { id: string };
        const query = c.req.valid("query") as { project_id: string; version?: number };
        return c.json(await dependencies.getPrompt(dependencies.pool(), { project_id: query.project_id, slug: params.id, version: query.version }));
      } catch (cause) {
        return failure(c, cause);
      }
    },
    handleListPromptVersions: async (c: Parameters<RouteHandler<typeof listPromptVersions>>[0]): Promise<Response> => {
      try {
        const params = c.req.valid("param") as { id: string };
        const query = c.req.valid("query") as { project_id: string };
        return c.json(await dependencies.listPromptVersions(dependencies.pool(), { project_id: query.project_id, slug: params.id }));
      } catch (cause) {
        return failure(c, cause);
      }
    },
    handleCreatePromptVersion: async (c: Parameters<RouteHandler<typeof createPromptVersion>>[0]): Promise<Response> => {
      try {
        const params = c.req.valid("param") as { id: string };
        const query = c.req.valid("query") as { project_id: string };
        const body = c.req.valid("json") as Omit<Parameters<typeof createPromptVersionRecord>[1], "project_id" | "slug" | "actor">;
        return c.json(await dependencies.createPromptVersion(dependencies.pool(), { ...body, project_id: query.project_id, slug: params.id, actor: actor(c) }), 201);
      } catch (cause) {
        return failure(c, cause);
      }
    },
    handleRenderPrompt: async (c: Parameters<RouteHandler<typeof renderPrompt>>[0]): Promise<Response> => {
      try {
        const params = c.req.valid("param") as { id: string };
        const query = c.req.valid("query") as { project_id: string; version?: number };
        const body = c.req.valid("json") as { data: JsonObject };
        return c.json(await dependencies.renderPrompt(dependencies.pool(), { project_id: query.project_id, slug: params.id, version: query.version, data: body.data }));
      } catch (cause) {
        return failure(c, cause);
      }
    },
    handlePreviewPrompt: async (c: Parameters<RouteHandler<typeof previewPrompt>>[0]): Promise<Response> => {
      try {
        const body = c.req.valid("json") as { messages: { role: "system" | "user"; content: string }[]; data: JsonObject };
        return c.json(renderPromptTemplatesWithWarnings(body.messages, body.data));
      } catch (cause) {
        return failure(c, cause);
      }
    },
    handleDeletePrompt: async (c: Parameters<RouteHandler<typeof deletePrompt>>[0]): Promise<Response> => {
      try {
        const params = c.req.valid("param") as { id: string };
        const query = c.req.valid("query") as { project_id: string };
        const body = c.req.valid("json") as { confirmation: string };
        await dependencies.deletePrompt(dependencies.pool(), { project_id: query.project_id, slug: params.id, confirmation: body.confirmation, actor: actor(c) });
        return c.body(null, 204);
      } catch (cause) {
        return failure(c, cause);
      }
    },
  };
}

export const {
  handleCreatePrompt,
  handleCreatePromptVersion,
  handleDeletePrompt,
  handleGetPrompt,
  handleListPromptVersions,
  handleListPrompts,
  handlePreviewPrompt,
  handleRenderPrompt,
} = createPromptRouteHandlers();
