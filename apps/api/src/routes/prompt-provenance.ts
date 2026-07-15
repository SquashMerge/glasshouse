import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { promptProvenanceStatus, PromptRepositoryError } from "../db/prompts.js";
import { pgPool } from "../db/postgres.js";
import {
  PromptErrorResponses,
  PromptIdParam,
  PromptProvenanceQuery,
  PromptProvenanceStatus,
} from "../schemas/prompts.js";

export const getPromptProvenance = createRoute({
  method: "get",
  path: "/v1/prompt-provenance/{id}",
  tags: ["prompts"],
  summary: "Check prompt provenance tuple status",
  security: [{ basicAuth: [] }],
  request: { params: PromptIdParam, query: PromptProvenanceQuery },
  responses: { 200: { description: "Status", content: { "application/json": { schema: PromptProvenanceStatus } } }, ...PromptErrorResponses },
});

export async function handleGetPromptProvenance(c: Context): Promise<Response> {
  try {
    const params = c.req.valid("param") as { id: string };
    const query = c.req.valid("query") as { project_id: string; version: number; content_hash: string };
    return c.json({
      status: await promptProvenanceStatus(pgPool(), {
        project_id: query.project_id,
        slug: params.id,
        version: query.version,
        content_hash: query.content_hash,
      }),
    });
  } catch (cause) {
    const known = cause instanceof PromptRepositoryError
      ? cause
      : new PromptRepositoryError("INTERNAL", "Prompt provenance operation failed", cause);
    return c.json({ code: known.code, message: known.code === "INTERNAL" ? "Prompt provenance operation failed" : known.message }, known.status);
  }
}
