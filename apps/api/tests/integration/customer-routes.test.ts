import { describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { CUSTOMER_CREDENTIAL_CONTEXT_KEY, customerCredentialAuthMiddleware } from "../../src/middleware/customer-credential-auth";
import {
  createCustomerCredential,
  createCustomerCredentialRouteHandlers,
  listCustomerCredentials,
  revokeCustomerCredential,
} from "../../src/routes/customer-credentials";
import {
  createCustomerPromptRouteHandlers,
  customerCreatePrompt,
  customerGetPrompt,
  customerListPromptVersions,
  customerListPrompts,
  customerCreatePromptVersion,
  customerRenderPrompt,
} from "../../src/routes/customer-prompts";
import { TRUSTED_ACTOR_CONTEXT_KEY } from "../../src/middleware/auth";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL = "550e8400-e29b-41d4-a716-446655440000";
const PROMPT = { id: "support-agent", project_id: PROJECT, name: "Support", description: null, version: 1, messages: [{ role: "system", content: "Hello" }], model: null, settings: {}, change_summary: "Initial version", created_by: "credential", created_at: "2026-07-16T10:00:00.000Z", content_hash: "a".repeat(64), diff: null };

function customerApp(scopes: Array<"prompts:read" | "prompts:render" | "prompts:write">) {
  const listPrompts = mock(async (_pool: unknown, projectId: string) => ({ items: [{ ...PROMPT, project_id: projectId }], total: 1 }));
  const getPrompt = mock(async (_pool: unknown, input: { project_id: string }) => ({ ...PROMPT, project_id: input.project_id }));
  const listPromptVersions = mock(async () => ({ items: [{ ...PROMPT, project_id: undefined }] }));
  const createPrompt = mock(async (_pool: unknown, input: Record<string, unknown>) => ({ ...PROMPT, ...input }));
  const createPromptVersion = mock(async (_pool: unknown, input: Record<string, unknown>) => ({ ...PROMPT, ...input, project_id: undefined }));
  const renderPrompt = mock(async (_pool: unknown, input: { project_id: string }) => ({ id: "support-agent", version: 1, content_hash: "a".repeat(64), messages: [{ role: "system", content: input.project_id }], warnings: [] }));
  const handlers = createCustomerPromptRouteHandlers({ pool: () => ({}) as never, listPrompts, getPrompt, listPromptVersions, createPrompt, createPromptVersion, renderPrompt });
  const api = new OpenAPIHono({ defaultHook: (result, c) => result.success ? undefined : c.json({ code: "BAD_REQUEST", message: "Request validation failed" }, 400) });
  api.use("/v1/customer/*", async (c, next) => { c.set(CUSTOMER_CREDENTIAL_CONTEXT_KEY, { id: CREDENTIAL, project_id: PROJECT, scopes }); await next(); });
  api.openapi(customerListPrompts, handlers.handleCustomerListPrompts);
  api.openapi(customerCreatePrompt, handlers.handleCustomerCreatePrompt);
  api.openapi(customerGetPrompt, handlers.handleCustomerGetPrompt);
  api.openapi(customerListPromptVersions, handlers.handleCustomerListPromptVersions);
  api.openapi(customerCreatePromptVersion, handlers.handleCustomerCreatePromptVersion);
  api.openapi(customerRenderPrompt, handlers.handleCustomerRenderPrompt);
  return { api, listPrompts, getPrompt, renderPrompt, createPrompt };
}

describe("customer prompt routes", () => {
  it("derives the project from the credential rather than trusting arbitrary project parameters", async () => {
    const { api, listPrompts } = customerApp(["prompts:read"]);
    const listed = await api.request("/v1/customer/prompts");
    const injected = await api.request(`/v1/customer/prompts?project_id=${OTHER_PROJECT}`);

    expect(listed.status).toBe(200);
    expect(listPrompts.mock.calls[0]?.[1]).toBe(PROJECT);
    expect(injected.status).toBe(200);
    expect(listPrompts.mock.calls[1]?.[1]).toBe(PROJECT);
  });

  it("enforces independent read, render, and write scopes", async () => {
    const readOnly = customerApp(["prompts:read"]);
    const renderOnly = customerApp(["prompts:render"]);
    const writeOnly = customerApp(["prompts:write"]);

    expect((await readOnly.api.request("/v1/customer/prompts/support-agent/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: {} }) })).status).toBe(403);
    expect((await renderOnly.api.request("/v1/customer/prompts")).status).toBe(403);
    expect((await writeOnly.api.request("/v1/customer/prompts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "New", messages: [{ role: "system", content: "Hello" }] }) })).status).toBe(201);
    expect(writeOnly.createPrompt.mock.calls[0]?.[1]).toMatchObject({ project_id: PROJECT, actor: `customer-credential:${CREDENTIAL}` });
  });

  it("keeps rendering in the bound project and does not register admin-only prompt operations", async () => {
    const { api, renderPrompt } = customerApp(["prompts:render"]);
    const rendered = await api.request("/v1/customer/prompts/support-agent/render?version=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: {} }) });
    const preview = await api.request("/v1/customer/prompts/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: {} }) });
    const deleted = await api.request("/v1/customer/prompts/support-agent", { method: "DELETE" });

    expect(rendered.status).toBe(200);
    expect(renderPrompt.mock.calls[0]?.[1]).toMatchObject({ project_id: PROJECT });
    expect(preview.status).toBe(404);
    expect(deleted.status).toBe(404);
  });
});

describe("customer credential management routes", () => {
  it("returns a secret only from creation and never from list or revoke responses", async () => {
    const credential = { id: CREDENTIAL, project_id: PROJECT, display_name: "Renderer", prefix: "astraea_ck_abc", fingerprint: "123456789abc", scopes: ["prompts:read" as const], created_by: "admin", created_at: "2026-07-16T10:00:00.000Z", expires_at: null, revoked_at: null, last_used_at: null };
    const createRecord = mock(async () => ({ ...credential, secret: "astraea_ck_once" }));
    const listRecord = mock(async () => ({ items: [credential] }));
    const revokeRecord = mock(async () => ({ ...credential, revoked_at: "2026-07-16T11:00:00.000Z" }));
    const handlers = createCustomerCredentialRouteHandlers({ pool: () => ({}) as never, createCustomerCredential: createRecord, listCustomerCredentials: listRecord, revokeCustomerCredential: revokeRecord });
    const api = new OpenAPIHono({ defaultHook: (result, c) => result.success ? undefined : c.json({ code: "BAD_REQUEST", message: "Request validation failed" }, 400) });
    api.use("/v1/*", async (c, next) => { c.set(TRUSTED_ACTOR_CONTEXT_KEY, "admin"); await next(); });
    api.openapi(listCustomerCredentials, handlers.handleListCustomerCredentials);
    api.openapi(createCustomerCredential, handlers.handleCreateCustomerCredential);
    api.openapi(revokeCustomerCredential, handlers.handleRevokeCustomerCredential);

    const created = await api.request("/v1/customer-credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: PROJECT, display_name: "Renderer", scopes: ["prompts:read"] }) });
    const listed = await api.request(`/v1/customer-credentials?project_id=${PROJECT}`);
    const revoked = await api.request(`/v1/customer-credentials/${CREDENTIAL}/revoke?project_id=${PROJECT}`, { method: "POST" });

    expect((await created.json() as { secret: string }).secret).toBe("astraea_ck_once");
    expect(JSON.stringify(await listed.json())).not.toContain("astraea_ck_once");
    expect(JSON.stringify(await revoked.json())).not.toContain("astraea_ck_once");
  });
});

describe("customer credential auth middleware", () => {
  it("accepts only a validated bearer credential and fails closed", async () => {
    const authenticate = mock(async (_pool: unknown, token: string) => token === "valid" ? { id: CREDENTIAL, project_id: PROJECT, scopes: ["prompts:read" as const] } : null);
    const api = new OpenAPIHono();
    api.use("/v1/customer/*", customerCredentialAuthMiddleware({ pool: () => ({}) as never, authenticate }));
    api.get("/v1/customer/prompts", (c) => c.json(c.get(CUSTOMER_CREDENTIAL_CONTEXT_KEY)));

    expect((await api.request("/v1/customer/prompts", { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    const ok = await api.request("/v1/customer/prompts", { headers: { authorization: "Bearer valid" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ project_id: PROJECT });
  });
});
