import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  createPrompt as createPromptRecord,
  createPromptVersion as createPromptVersionRecord,
  getPrompt as getPromptRecord,
  listPromptVersions as listPromptVersionsRecord,
  listPrompts as listPromptsRecord,
  PromptRepositoryError,
  renderPrompt as renderPromptRecord,
  type JsonObject,
  type PromptRole,
} from "../db/prompts.js";
import { pgPool } from "../db/postgres.js";
import { customerCredential, hasCustomerCredentialScope } from "../middleware/customer-credential-auth.js";
import { ErrorEnvelope } from "../schemas/common.js";
import {
  Prompt,
  PromptCreate,
  PromptErrorResponses,
  PromptIdParam,
  PromptRender,
  PromptRenderResponse,
  PromptVersion,
  PromptVersionCreate,
} from "../schemas/prompts.js";

const tag = "customer-prompts";
const PromptList = z.object({ items: z.array(Prompt), total: z.number().int().nonnegative() }).strict();
const PromptVersionList = z.object({ items: z.array(PromptVersion) }).strict();
const CustomerPromptCreate = PromptCreate.omit({ project_id: true });

function failure(c: Context, cause: unknown): Response {
  const known = cause instanceof PromptRepositoryError ? cause : new PromptRepositoryError("INTERNAL", "Prompt operation failed", cause);
  return c.json({ code: known.code, message: known.code === "INTERNAL" ? "Prompt operation failed" : known.message }, known.status);
}

function credentialProject(c: Context): string {
  const credential = customerCredential(c);
  if (!credential) throw new PromptRepositoryError("INTERNAL", "Customer credential is unavailable");
  return credential.project_id;
}

function scopeFailure(c: Context, scope: "prompts:read" | "prompts:render" | "prompts:write"): Response | null {
  return hasCustomerCredentialScope(c, scope) ? null : c.json({ code: "FORBIDDEN", message: `Credential lacks ${scope} scope` }, 403);
}

export type CustomerPromptRouteDependencies = {
  pool: typeof pgPool;
  createPrompt: typeof createPromptRecord;
  createPromptVersion: typeof createPromptVersionRecord;
  getPrompt: typeof getPromptRecord;
  listPromptVersions: typeof listPromptVersionsRecord;
  listPrompts: typeof listPromptsRecord;
  renderPrompt: typeof renderPromptRecord;
};

const productionDependencies: CustomerPromptRouteDependencies = {
  pool: pgPool,
  createPrompt: createPromptRecord,
  createPromptVersion: createPromptVersionRecord,
  getPrompt: getPromptRecord,
  listPromptVersions: listPromptVersionsRecord,
  listPrompts: listPromptsRecord,
  renderPrompt: renderPromptRecord,
};

const customerSecurity = [{ customerApiKey: [] }];
const customerErrors = {
  ...PromptErrorResponses,
  401: { description: "Unauthorized", content: { "application/json": { schema: ErrorEnvelope } } },
  403: { description: "Forbidden", content: { "application/json": { schema: ErrorEnvelope } } },
};

export const customerListPrompts = createRoute({
  method: "get", path: "/v1/customer/prompts", tags: [tag], summary: "List prompts bound to the credential project", security: customerSecurity,
  responses: { 200: { description: "OK", content: { "application/json": { schema: PromptList } } }, ...customerErrors },
});
export const customerCreatePrompt = createRoute({
  method: "post", path: "/v1/customer/prompts", tags: [tag], summary: "Create a prompt in the credential project", security: customerSecurity,
  request: { body: { content: { "application/json": { schema: CustomerPromptCreate } } } },
  responses: { 201: { description: "Prompt created", content: { "application/json": { schema: Prompt } } }, ...customerErrors },
});
export const customerGetPrompt = createRoute({
  method: "get", path: "/v1/customer/prompts/{id}", tags: [tag], summary: "Get a prompt from the credential project", security: customerSecurity,
  request: { params: PromptIdParam, query: z.object({ version: z.coerce.number().int().positive().optional().openapi({ param: { name: "version", in: "query" } }) }).strict() },
  responses: { 200: { description: "OK", content: { "application/json": { schema: Prompt } } }, ...customerErrors },
});
export const customerListPromptVersions = createRoute({
  method: "get", path: "/v1/customer/prompts/{id}/versions", tags: [tag], summary: "List prompt versions from the credential project", security: customerSecurity,
  request: { params: PromptIdParam }, responses: { 200: { description: "OK", content: { "application/json": { schema: PromptVersionList } } }, ...customerErrors },
});
export const customerCreatePromptVersion = createRoute({
  method: "post", path: "/v1/customer/prompts/{id}/versions", tags: [tag], summary: "Create a prompt version in the credential project", security: customerSecurity,
  request: { params: PromptIdParam, body: { content: { "application/json": { schema: PromptVersionCreate } } } },
  responses: { 201: { description: "Version created", content: { "application/json": { schema: PromptVersion } } }, ...customerErrors },
});
export const customerRenderPrompt = createRoute({
  method: "post", path: "/v1/customer/prompts/{id}/render", tags: [tag], summary: "Render a credential-project prompt", security: customerSecurity,
  request: { params: PromptIdParam, query: z.object({ version: z.coerce.number().int().positive().optional().openapi({ param: { name: "version", in: "query" } }) }).strict(), body: { content: { "application/json": { schema: PromptRender } } } },
  responses: { 200: { description: "Rendered", content: { "application/json": { schema: PromptRenderResponse } } }, ...customerErrors },
});

export function createCustomerPromptRouteHandlers(dependencies: CustomerPromptRouteDependencies = productionDependencies) {
  return {
    handleCustomerListPrompts: async (c: Parameters<RouteHandler<typeof customerListPrompts>>[0]): Promise<Response> => {
      const denied = scopeFailure(c, "prompts:read"); if (denied) return denied;
      try { return c.json(await dependencies.listPrompts(dependencies.pool(), credentialProject(c))); } catch (cause) { return failure(c, cause); }
    },
    handleCustomerCreatePrompt: async (c: Parameters<RouteHandler<typeof customerCreatePrompt>>[0]): Promise<Response> => {
      const denied = scopeFailure(c, "prompts:write"); if (denied) return denied;
      try {
        const body = c.req.valid("json") as { name: string; description?: string | null; messages: { role: PromptRole; content: string }[]; model?: string | null; settings?: JsonObject; change_summary?: string };
        const credential = customerCredential(c)!;
        return c.json(await dependencies.createPrompt(dependencies.pool(), { ...body, project_id: credentialProject(c), actor: `customer-credential:${credential.id}` }), 201);
      } catch (cause) { return failure(c, cause); }
    },
    handleCustomerGetPrompt: async (c: Parameters<RouteHandler<typeof customerGetPrompt>>[0]): Promise<Response> => {
      const denied = scopeFailure(c, "prompts:read"); if (denied) return denied;
      try {
        const params = c.req.valid("param") as { id: string }; const query = c.req.valid("query") as { version?: number };
        return c.json(await dependencies.getPrompt(dependencies.pool(), { project_id: credentialProject(c), slug: params.id, version: query.version }));
      } catch (cause) { return failure(c, cause); }
    },
    handleCustomerListPromptVersions: async (c: Parameters<RouteHandler<typeof customerListPromptVersions>>[0]): Promise<Response> => {
      const denied = scopeFailure(c, "prompts:read"); if (denied) return denied;
      try { const params = c.req.valid("param") as { id: string }; return c.json(await dependencies.listPromptVersions(dependencies.pool(), { project_id: credentialProject(c), slug: params.id })); } catch (cause) { return failure(c, cause); }
    },
    handleCustomerCreatePromptVersion: async (c: Parameters<RouteHandler<typeof customerCreatePromptVersion>>[0]): Promise<Response> => {
      const denied = scopeFailure(c, "prompts:write"); if (denied) return denied;
      try {
        const params = c.req.valid("param") as { id: string }; const body = c.req.valid("json") as { base_version: number; messages: { role: PromptRole; content: string }[]; model?: string | null; settings?: JsonObject; change_summary: string };
        const credential = customerCredential(c)!;
        return c.json(await dependencies.createPromptVersion(dependencies.pool(), { ...body, project_id: credentialProject(c), slug: params.id, actor: `customer-credential:${credential.id}` }), 201);
      } catch (cause) { return failure(c, cause); }
    },
    handleCustomerRenderPrompt: async (c: Parameters<RouteHandler<typeof customerRenderPrompt>>[0]): Promise<Response> => {
      const denied = scopeFailure(c, "prompts:render"); if (denied) return denied;
      try {
        const params = c.req.valid("param") as { id: string }; const query = c.req.valid("query") as { version?: number }; const body = c.req.valid("json") as { data: JsonObject };
        return c.json(await dependencies.renderPrompt(dependencies.pool(), { project_id: credentialProject(c), slug: params.id, version: query.version, data: body.data }));
      } catch (cause) { return failure(c, cause); }
    },
  };
}

export const {
  handleCustomerCreatePrompt,
  handleCustomerCreatePromptVersion,
  handleCustomerGetPrompt,
  handleCustomerListPromptVersions,
  handleCustomerListPrompts,
  handleCustomerRenderPrompt,
} = createCustomerPromptRouteHandlers();
