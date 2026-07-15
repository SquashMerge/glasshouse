import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { listProjects as listProjectsRecord, PromptRepositoryError } from "../db/prompts.js";
import { pgPool } from "../db/postgres.js";
import { ProjectErrorResponses, ProjectList } from "../schemas/projects.js";

export const listProjects = createRoute({
  method: "get",
  path: "/v1/projects",
  tags: ["projects"],
  summary: "List all projects available to the trusted administrator",
  security: [{ basicAuth: [] }],
  responses: { 200: { description: "OK", content: { "application/json": { schema: ProjectList } } }, ...ProjectErrorResponses },
});

export async function handleListProjects(c: Context): Promise<Response> {
  try {
    return c.json(await listProjectsRecord(pgPool()));
  } catch (cause) {
    const known = cause instanceof PromptRepositoryError
      ? cause
      : new PromptRepositoryError("INTERNAL", "Project operation failed", cause);
    return c.json({ code: known.code, message: known.code === "INTERNAL" ? "Project operation failed" : known.message }, known.status);
  }
}
