import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import type { Context } from "hono";
import { healthRoute, handleHealth } from "./routes/health.js";
import { loginRoute, handleLogin } from "./routes/auth.js";
import { otlpIngestRoute, handleOtlpIngest } from "./routes/otlp.js";
import {
	createAgent,
	handleCreateAgent,
	listAgents,
	handleListAgents,
	getAgent,
	handleGetAgent,
	patchAgent,
	handlePatchAgent,
	deleteAgent,
	handleDeleteAgent,
	syncAgent,
	handleSyncAgent,
	runAgent,
	handleRunAgent,
	listAgentVersions,
	handleListAgentVersions,
} from "./routes/agents.js";
import {
	createExperiment,
	handleCreateExperiment,
	listExperiments,
	handleListExperiments,
	getExperiment,
	handleGetExperiment,
	getExperimentResults,
	handleGetExperimentResults,
	getExperimentSummary,
	handleGetExperimentSummary,
	getExperimentEvents,
	handleGetExperimentEvents,
	cancelExperiment,
	handleCancelExperiment,
} from "./routes/experiments.js";
import {
	listTraces,
	handleListTraces,
	getTrace,
	handleGetTrace,
	listObservations,
	handleListObservations,
} from "./routes/traces.js";
import {
	streamTraceEvents,
	handleStreamTraceEvents,
	streamObservationEvents,
	handleStreamObservationEvents,
	streamTraceDetailEvents,
	handleStreamTraceDetailEvents,
} from "./routes/trace-events.js";
import {
	listPrompts,
	handleListPrompts,
	createPrompt,
	handleCreatePrompt,
	getPrompt,
	handleGetPrompt,
	listPromptVersions,
	handleListPromptVersions,
	createPromptVersion,
	handleCreatePromptVersion,
	renderPrompt,
	handleRenderPrompt,
	previewPrompt,
	handlePreviewPrompt,
	deletePrompt,
	handleDeletePrompt,
	rollbackLatestPromptVersion,
	handleRollbackLatestPromptVersion,
} from "./routes/prompts.js";
import { listProjects, handleListProjects } from "./routes/projects.js";
import {
	getPromptProvenance,
	handleGetPromptProvenance,
} from "./routes/prompt-provenance.js";
import {
	startOptimization,
	getActiveOptimization,
	getOptimization,
	stopOptimization,
	optimizationEvents,
	handleStart,
	handleGetActive,
	handleGet,
	handleStop,
	handleEvents,
} from "./routes/prompt-optimizations.js";
import {
	listDatasets,
	handleListDatasets,
	createDataset,
	handleCreateDataset,
	getDataset,
	handleGetDataset,
	listDatasetItems,
	handleListDatasetItems,
	addDatasetItem,
	handleAddDatasetItem,
	deleteDatasetItem,
	handleDeleteDatasetItem,
} from "./routes/datasets.js";
import {
	createScore,
	handleCreateScore,
	getScore,
	handleGetScore,
} from "./routes/scores.js";

export const openapiApp = new OpenAPIHono({
	defaultHook: (result, c) => {
		if (!result.success) {
			return c.json(
				{ code: "BAD_REQUEST", message: "Request validation failed" },
				400,
			);
		}
	},
});
openapiApp.openAPIRegistry.registerComponent("securitySchemes", "basicAuth", {
	type: "http",
	scheme: "basic",
});
const register = (route: unknown, handler: unknown): void => {
	openapiApp.openapi(route as never, handler as never);
};

openapiApp.use("/v1/prompts/*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	await next();
});
openapiApp.use("/v1/prompt-provenance/*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	await next();
});
openapiApp.use("/v1/prompt-optimizations/*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	await next();
});

// Health (also mounted at /health by the bare handler in index.ts).
register(healthRoute, handleHealth);

// Login: gated by basicAuthMiddleware in index.ts via the parent /v1/* mount.
register(loginRoute, handleLogin);
register(otlpIngestRoute, (c: Context) => handleOtlpIngest(c.req.raw));

register(createAgent, handleCreateAgent);
register(listAgents, handleListAgents);
register(getAgent, (c: Context) => handleGetAgent(c.req.param("id")!));
register(patchAgent, (c: Context) => handlePatchAgent(c.req.param("id")!));
register(deleteAgent, (c: Context) => handleDeleteAgent(c.req.param("id")!));
register(syncAgent, (c: Context) => handleSyncAgent(c.req.param("id")!));
register(runAgent, (c: Context) => handleRunAgent(c.req.param("id")!));
register(listAgentVersions, (c: Context) =>
	handleListAgentVersions(c.req.param("id")!),
);

register(createExperiment, handleCreateExperiment);
register(listExperiments, handleListExperiments);
register(getExperiment, (c: Context) =>
	handleGetExperiment(c.req.param("id")!),
);
register(getExperimentResults, (c: Context) =>
	handleGetExperimentResults(c.req.param("id")!),
);
register(getExperimentSummary, (c: Context) =>
	handleGetExperimentSummary(c.req.param("id")!),
);
register(getExperimentEvents, (c: Context) =>
	handleGetExperimentEvents(c.req.param("id")!),
);
register(cancelExperiment, (c: Context) =>
	handleCancelExperiment(c.req.param("id")!),
);

register(listTraces, handleListTraces);
// Register the more specific /v1/traces/events SSE route BEFORE
// /v1/traces/{id} so a literal "events" segment doesn't fall into the
// `{id}` placeholder (which would fail the 32-hex regex validation).
register(streamTraceEvents, handleStreamTraceEvents);
register(getTrace, handleGetTrace);
register(listObservations, handleListObservations);
register(streamObservationEvents, handleStreamObservationEvents);
register(streamTraceDetailEvents, handleStreamTraceDetailEvents);

register(listProjects, handleListProjects);
register(listPrompts, handleListPrompts);
register(createPrompt, handleCreatePrompt);
register(previewPrompt, handlePreviewPrompt);
register(listPromptVersions, handleListPromptVersions);
register(createPromptVersion, handleCreatePromptVersion);
register(rollbackLatestPromptVersion, handleRollbackLatestPromptVersion);
register(renderPrompt, handleRenderPrompt);
register(deletePrompt, handleDeletePrompt);
register(getPrompt, handleGetPrompt);
register(getPromptProvenance, handleGetPromptProvenance);
register(startOptimization, handleStart);
register(getActiveOptimization, handleGetActive);
register(optimizationEvents, handleEvents);
register(stopOptimization, handleStop);
register(getOptimization, handleGet);

register(listDatasets, handleListDatasets);
register(createDataset, handleCreateDataset);
register(getDataset, handleGetDataset);
register(listDatasetItems, handleListDatasetItems);
register(addDatasetItem, handleAddDatasetItem);
register(deleteDatasetItem, handleDeleteDatasetItem);

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
