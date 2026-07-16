import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import type { Context } from "hono";
import { healthRoute, handleHealth } from "./routes/health.js";
import { loginRoute, handleLogin } from "./routes/auth.js";
import {
  createAgent, handleCreateAgent,
  listAgents, handleListAgents,
  getAgent, handleGetAgent,
  patchAgent, handlePatchAgent,
  deleteAgent, handleDeleteAgent,
  syncAgent, handleSyncAgent,
  runAgent, handleRunAgent,
  listAgentVersions, handleListAgentVersions,
} from "./routes/agents.js";
import {
  createExperiment, handleCreateExperiment,
  listExperiments, handleListExperiments,
  getExperiment, handleGetExperiment,
  getExperimentResults, handleGetExperimentResults,
  getExperimentSummary, handleGetExperimentSummary,
  getExperimentEvents, handleGetExperimentEvents,
  cancelExperiment, handleCancelExperiment,
} from "./routes/experiments.js";
import {
  listTraces, handleListTraces,
  getTrace, handleGetTrace,
  listObservations, handleListObservations,
} from "./routes/traces.js";
import {
  streamTraceEvents, handleStreamTraceEvents,
  streamObservationEvents, handleStreamObservationEvents,
  streamTraceDetailEvents, handleStreamTraceDetailEvents,
} from "./routes/trace-events.js";
import {
  listPrompts, handleListPrompts,
  createPrompt, handleCreatePrompt,
  getPrompt, handleGetPrompt,
  listPromptVersions, handleListPromptVersions,
  createPromptVersion, handleCreatePromptVersion,
  patchPromptLabels, handlePatchPromptLabels,
} from "./routes/prompts.js";
import {
  listDatasets, handleListDatasets,
  createDataset, handleCreateDataset,
  getDataset, handleGetDataset,
  listDatasetItems, handleListDatasetItems,
  addDatasetItem, handleAddDatasetItem,
  deleteDatasetItem, handleDeleteDatasetItem,
} from "./routes/datasets.js";
import {
  createScore, handleCreateScore,
  getScore, handleGetScore,
} from "./routes/scores.js";

export const openapiApp = new OpenAPIHono();
openapiApp.openAPIRegistry.registerComponent("securitySchemes", "basicAuth", {
  type: "http",
  scheme: "basic",
});
const register = (route: unknown, handler: unknown): void => {
  openapiApp.openapi(route as never, handler as never);
};

// Health (also mounted at /health by the bare handler in index.ts).
register(healthRoute, handleHealth);

// Login: gated by basicAuthMiddleware in index.ts via the parent /v1/* mount.
register(loginRoute, handleLogin);

register(createAgent, handleCreateAgent);
register(listAgents, handleListAgents);
register(getAgent, (c: Context) => handleGetAgent(c.req.param("id")!));
register(patchAgent, (c: Context) => handlePatchAgent(c.req.param("id")!));
register(deleteAgent, (c: Context) => handleDeleteAgent(c.req.param("id")!));
register(syncAgent, (c: Context) => handleSyncAgent(c.req.param("id")!));
register(runAgent, (c: Context) => handleRunAgent(c.req.param("id")!));
register(listAgentVersions, (c: Context) => handleListAgentVersions(c.req.param("id")!));

register(createExperiment, handleCreateExperiment);
register(listExperiments, handleListExperiments);
register(getExperiment, (c: Context) => handleGetExperiment(c.req.param("id")!));
register(getExperimentResults, (c: Context) => handleGetExperimentResults(c.req.param("id")!));
register(getExperimentSummary, (c: Context) => handleGetExperimentSummary(c.req.param("id")!));
register(getExperimentEvents, (c: Context) => handleGetExperimentEvents(c.req.param("id")!));
register(cancelExperiment, (c: Context) => handleCancelExperiment(c.req.param("id")!));

register(listTraces, handleListTraces);
// Register the more specific /v1/traces/events SSE route BEFORE
// /v1/traces/{id} so a literal "events" segment doesn't fall into the
// `{id}` placeholder (which would fail the 32-hex regex validation).
register(streamTraceEvents, handleStreamTraceEvents);
register(getTrace, handleGetTrace);
register(listObservations, handleListObservations);
register(streamObservationEvents, handleStreamObservationEvents);
register(streamTraceDetailEvents, handleStreamTraceDetailEvents);

register(listPrompts, handleListPrompts);
register(createPrompt, handleCreatePrompt);
register(getPrompt, (c: Context) => handleGetPrompt(c.req.param("id")!));
register(listPromptVersions, (c: Context) => handleListPromptVersions(c.req.param("id")!));
register(createPromptVersion, (c: Context) => handleCreatePromptVersion(c.req.param("id")!));
register(patchPromptLabels, (c: Context) => handlePatchPromptLabels(c.req.param("id")!));

register(listDatasets, handleListDatasets);
register(createDataset, handleCreateDataset);
register(getDataset, (c: Context) => handleGetDataset(c.req.param("id")!));
register(listDatasetItems, (c: Context) => handleListDatasetItems(c.req.param("id")!));
register(addDatasetItem, (c: Context) => handleAddDatasetItem(c.req.param("id")!));
register(deleteDatasetItem, (c: Context) => handleDeleteDatasetItem(c.req.param("id")!, c.req.param("itemId")!));

register(createScore, handleCreateScore);
register(getScore, (c: Context) => handleGetScore(c.req.param("id")!));

openapiApp.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Astraea API",
    version: "0.1.0",
    description: "Agent and LLM evaluation platform.",
  },
  servers: [{ url: "http://localhost:3000", description: "Local dev" }],
});

openapiApp.get(
  "/reference",
  apiReference({
    theme: "default",
    darkMode: true,
    spec: { url: "/openapi.json" },
  }),
);
