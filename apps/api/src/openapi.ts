import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { healthRoute, handleHealth } from "./routes/health.js";
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
  searchTraces, handleSearchTraces,
} from "./routes/traces.js";
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

// Health (also mounted at /health by the bare handler in index.ts).
openapiApp.openapi(healthRoute, handleHealth);

// Agents (8 routes)
openapiApp.openapi(createAgent, handleCreateAgent);
openapiApp.openapi(listAgents, handleListAgents);
openapiApp.openapi(getAgent, (c) => handleGetAgent(c.req.valid("param").id));
openapiApp.openapi(patchAgent, (c) => handlePatchAgent(c.req.valid("param").id));
openapiApp.openapi(deleteAgent, (c) => handleDeleteAgent(c.req.valid("param").id));
openapiApp.openapi(syncAgent, (c) => handleSyncAgent(c.req.valid("param").id));
openapiApp.openapi(runAgent, (c) => handleRunAgent(c.req.valid("param").id));
openapiApp.openapi(listAgentVersions, (c) => handleListAgentVersions(c.req.valid("param").id));

// Experiments (7 routes)
openapiApp.openapi(createExperiment, handleCreateExperiment);
openapiApp.openapi(listExperiments, handleListExperiments);
openapiApp.openapi(getExperiment, (c) => handleGetExperiment(c.req.valid("param").id));
openapiApp.openapi(getExperimentResults, (c) => handleGetExperimentResults(c.req.valid("param").id));
openapiApp.openapi(getExperimentSummary, (c) => handleGetExperimentSummary(c.req.valid("param").id));
openapiApp.openapi(getExperimentEvents, (c) => handleGetExperimentEvents(c.req.valid("param").id));
openapiApp.openapi(cancelExperiment, (c) => handleCancelExperiment(c.req.valid("param").id));

// Traces (3 routes)
openapiApp.openapi(listTraces, handleListTraces);
openapiApp.openapi(getTrace, handleGetTrace);
openapiApp.openapi(searchTraces, handleSearchTraces);

// Prompts (6 routes)
openapiApp.openapi(listPrompts, handleListPrompts);
openapiApp.openapi(createPrompt, handleCreatePrompt);
openapiApp.openapi(getPrompt, (c) => handleGetPrompt(c.req.valid("param").id));
openapiApp.openapi(listPromptVersions, (c) => handleListPromptVersions(c.req.valid("param").id));
openapiApp.openapi(createPromptVersion, (c) => handleCreatePromptVersion(c.req.valid("param").id));
openapiApp.openapi(patchPromptLabels, (c) => handlePatchPromptLabels(c.req.valid("param").id));

// Datasets (6 routes incl. nested item)
openapiApp.openapi(listDatasets, handleListDatasets);
openapiApp.openapi(createDataset, handleCreateDataset);
openapiApp.openapi(getDataset, (c) => handleGetDataset(c.req.valid("param").id));
openapiApp.openapi(listDatasetItems, (c) => handleListDatasetItems(c.req.valid("param").id));
openapiApp.openapi(addDatasetItem, (c) => handleAddDatasetItem(c.req.valid("param").id));
openapiApp.openapi(deleteDatasetItem, (c) => handleDeleteDatasetItem(c.req.valid("param").id, c.req.valid("param").itemId));

// Scores (2 routes)
openapiApp.openapi(createScore, handleCreateScore);
openapiApp.openapi(getScore, (c) => handleGetScore(c.req.valid("param").id));

// OpenAPI JSON document endpoint
openapiApp.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Astraea API",
    version: "0.1.0",
    description: "Agent and LLM evaluation platform.",
  },
  servers: [{ url: "http://localhost:3000", description: "Local dev" }],
});

// Scalar UI at /reference
openapiApp.get(
  "/reference",
  apiReference({
    theme: "default",
    darkMode: true,
    spec: { url: "/openapi.json" },
  }),
);