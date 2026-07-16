import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  createCustomerCredential as createCustomerCredentialRecord,
  listCustomerCredentials as listCustomerCredentialsRecord,
  revokeCustomerCredential as revokeCustomerCredentialRecord,
  CustomerCredentialRepositoryError,
} from "../db/customer-credentials.js";
import { pgPool } from "../db/postgres.js";
import { TRUSTED_ACTOR_CONTEXT_KEY } from "../middleware/auth.js";
import {
  CustomerCredential,
  CustomerCredentialCreate,
  CustomerCredentialCreateResponse,
  CustomerCredentialErrorResponses,
  CustomerCredentialIdParam,
  CustomerCredentialList,
  CustomerCredentialProjectQuery,
} from "../schemas/customer-credentials.js";

const tag = "customer-credentials";

function actor(c: Context): string {
  const value = c.get(TRUSTED_ACTOR_CONTEXT_KEY);
  if (typeof value !== "string") throw new CustomerCredentialRepositoryError("INTERNAL", "Trusted actor is unavailable");
  return value;
}

function failure(c: Context, cause: unknown): Response {
  const known = cause instanceof CustomerCredentialRepositoryError
    ? cause
    : new CustomerCredentialRepositoryError("INTERNAL", "Customer credential operation failed", cause);
  return c.json({ code: known.code, message: known.code === "INTERNAL" ? "Customer credential operation failed" : known.message }, known.status);
}

export type CustomerCredentialRouteDependencies = {
  pool: typeof pgPool;
  createCustomerCredential: typeof createCustomerCredentialRecord;
  listCustomerCredentials: typeof listCustomerCredentialsRecord;
  revokeCustomerCredential: typeof revokeCustomerCredentialRecord;
};

const productionDependencies: CustomerCredentialRouteDependencies = {
  pool: pgPool,
  createCustomerCredential: createCustomerCredentialRecord,
  listCustomerCredentials: listCustomerCredentialsRecord,
  revokeCustomerCredential: revokeCustomerCredentialRecord,
};

export const listCustomerCredentials = createRoute({
  method: "get",
  path: "/v1/customer-credentials",
  tags: [tag],
  summary: "List customer API credentials for a project",
  security: [{ basicAuth: [] }],
  request: { query: CustomerCredentialProjectQuery },
  responses: { 200: { description: "OK", content: { "application/json": { schema: CustomerCredentialList } } }, ...CustomerCredentialErrorResponses },
});

export const createCustomerCredential = createRoute({
  method: "post",
  path: "/v1/customer-credentials",
  tags: [tag],
  summary: "Create a customer API credential",
  description: "Creates an opaque bearer credential. The secret is returned only in this response and is never stored or returned again.",
  security: [{ basicAuth: [] }],
  request: { body: { content: { "application/json": { schema: CustomerCredentialCreate } } } },
  responses: { 201: { description: "Credential created; secret is shown once", content: { "application/json": { schema: CustomerCredentialCreateResponse } } }, ...CustomerCredentialErrorResponses },
});

export const revokeCustomerCredential = createRoute({
  method: "post",
  path: "/v1/customer-credentials/{id}/revoke",
  tags: [tag],
  summary: "Revoke a customer API credential",
  security: [{ basicAuth: [] }],
  request: { params: CustomerCredentialIdParam, query: CustomerCredentialProjectQuery },
  responses: { 200: { description: "Credential revoked", content: { "application/json": { schema: CustomerCredential } } }, ...CustomerCredentialErrorResponses },
});

export function createCustomerCredentialRouteHandlers(dependencies: CustomerCredentialRouteDependencies = productionDependencies) {
  return {
    handleListCustomerCredentials: async (c: Parameters<RouteHandler<typeof listCustomerCredentials>>[0]): Promise<Response> => {
      try {
        const query = c.req.valid("query") as { project_id: string };
        return c.json(await dependencies.listCustomerCredentials(dependencies.pool(), query.project_id));
      } catch (cause) {
        return failure(c, cause);
      }
    },
    handleCreateCustomerCredential: async (c: Parameters<RouteHandler<typeof createCustomerCredential>>[0]): Promise<Response> => {
      try {
        const body = c.req.valid("json") as { project_id: string; display_name: string; scopes: ("prompts:read" | "prompts:render" | "prompts:write")[]; expires_at?: string | null };
        return c.json(await dependencies.createCustomerCredential(dependencies.pool(), { ...body, created_by: actor(c) }), 201);
      } catch (cause) {
        return failure(c, cause);
      }
    },
    handleRevokeCustomerCredential: async (c: Parameters<RouteHandler<typeof revokeCustomerCredential>>[0]): Promise<Response> => {
      try {
        const params = c.req.valid("param") as { id: string };
        const query = c.req.valid("query") as { project_id: string };
        return c.json(await dependencies.revokeCustomerCredential(dependencies.pool(), { id: params.id, project_id: query.project_id }));
      } catch (cause) {
        return failure(c, cause);
      }
    },
  };
}

export const {
  handleCreateCustomerCredential,
  handleListCustomerCredentials,
  handleRevokeCustomerCredential,
} = createCustomerCredentialRouteHandlers();
