import { describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRUSTED_ACTOR_CONTEXT_KEY } from "../../src/middleware/auth";

class TestPromptRepositoryError extends Error {
  readonly status: 400 | 404 | 409 | 500;

  constructor(
    readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "INTERNAL",
    message: string,
  ) {
    super(message);
    this.status = code === "BAD_REQUEST" ? 400 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 500;
  }
}

const createPromptRecord = mock(async (_pool: unknown, input: Record<string, unknown>) => ({
  id: "support-agent",
  project_id: input.project_id,
  name: input.name,
  description: null,
  version: 1,
  role: input.role,
  source: input.source,
  model: null,
  settings: {},
  change_summary: "Initial version",
  created_by: input.actor,
  created_at: "2026-07-15T10:00:00.000Z",
  content_hash: "a".repeat(64),
  diff: null,
}));
const deletePromptRecord = mock(async (_pool: unknown, input: { slug: string; confirmation: string }) => {
  if (input.slug !== input.confirmation) {
    throw new TestPromptRepositoryError("BAD_REQUEST", "confirmation must equal the prompt identifier");
  }
});
const getPromptRecord = mock(async () => {
  throw new TestPromptRepositoryError("NOT_FOUND", "Prompt or version not found");
});
const listProjectsRecord = mock(async () => ({
  items: [{ id: "11111111-1111-4111-8111-111111111111", name: "Project One", slug: "project-one", created_at: "2026-07-15T10:00:00.000Z" }],
  total: 1,
}));

mock.module("../../src/db/postgres", () => ({ pgPool: () => ({}) }));
mock.module("../../src/db/prompts", () => ({
  PromptRepositoryError: TestPromptRepositoryError,
  createPrompt: createPromptRecord,
  createPromptVersion: mock(async () => ({})),
  deletePrompt: deletePromptRecord,
  getPrompt: getPromptRecord,
  listPromptVersions: mock(async () => ({ items: [] })),
  listPrompts: mock(async () => ({ items: [], total: 0 })),
  listProjects: listProjectsRecord,
  renderPrompt: mock(async () => ({})),
}));

const {
  createPrompt,
  deletePrompt,
  getPrompt,
  handleCreatePrompt,
  handleDeletePrompt,
  handleGetPrompt,
} = await import("../../src/routes/prompts");
const { listProjects, handleListProjects } = await import("../../src/routes/projects");

const PROJECT = "11111111-1111-4111-8111-111111111111";

function app() {
  const api = new OpenAPIHono({
    defaultHook: (result, c) => result.success ? undefined : c.json({ code: "BAD_REQUEST", message: "Request validation failed" }, 400),
  });
  api.use("/v1/*", async (c, next) => {
    c.set(TRUSTED_ACTOR_CONTEXT_KEY, "context-admin");
    await next();
  });
  api.use("/v1/prompts/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  api.openapi(createPrompt, handleCreatePrompt);
  api.openapi(deletePrompt, handleDeletePrompt);
  api.openapi(getPrompt, handleGetPrompt);
  api.openapi(listProjects, handleListProjects);
  return api;
}

describe("prompt route contracts", () => {
  it("lists all projects for the globally trusted administrator", async () => {
    listProjectsRecord.mockClear();
    const response = await app().request("/v1/projects");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{ id: PROJECT, name: "Project One", slug: "project-one", created_at: "2026-07-15T10:00:00.000Z" }],
      total: 1,
    });
    expect(listProjectsRecord.mock.calls[0]).toHaveLength(1);
  });

  it("uses the trusted context actor rather than a request actor and returns public prompt ids", async () => {
    createPromptRecord.mockClear();
    const response = await app().request("/v1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: PROJECT,
        name: "Support Agent",
        role: "system",
        source: "Help {{customer}}",
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      id: "support-agent",
      project_id: PROJECT,
      name: "Support Agent",
      description: null,
      version: 1,
      role: "system",
      source: "Help {{customer}}",
      model: null,
      settings: {},
      change_summary: "Initial version",
      created_by: "context-admin",
      created_at: "2026-07-15T10:00:00.000Z",
      content_hash: "a".repeat(64),
      diff: null,
    });
    expect(createPromptRecord.mock.calls[0]?.[1]).toMatchObject({ actor: "context-admin" });
    expect(JSON.stringify(body)).not.toContain("internal-prompt-id");
  });

  it("rejects unknown body fields with the standard error envelope", async () => {
    const response = await app().request("/v1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: PROJECT,
        name: "Support Agent",
        role: "system",
        source: "source",
        actor: "spoofed",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "BAD_REQUEST", message: "Request validation failed" });
  });

  it("returns a project-scoped 404 envelope for an absent or cross-project prompt", async () => {
    const response = await app().request(`/v1/prompts/support-agent?project_id=${PROJECT}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "NOT_FOUND", message: "Prompt or version not found" });
  });

  it("requires raw deletion confirmation and marks successful delete responses no-store", async () => {
    deletePromptRecord.mockClear();
    const invalid = await app().request(`/v1/prompts/support-agent?project_id=${PROJECT}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "other-prompt" }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("Cache-Control")).toBe("no-store");
    expect(await invalid.json()).toEqual({ code: "BAD_REQUEST", message: "confirmation must equal the prompt identifier" });

    const deleted = await app().request(`/v1/prompts/support-agent?project_id=${PROJECT}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "support-agent" }),
    });
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("Cache-Control")).toBe("no-store");
    expect(deletePromptRecord.mock.calls[0]?.[1]).toEqual({
      project_id: PROJECT,
      slug: "support-agent",
      confirmation: "support-agent",
      actor: "context-admin",
    });
  });
});
