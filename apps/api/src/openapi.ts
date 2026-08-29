import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import type { Context } from "hono";
import { healthRoute, handleHealth } from "./routes/health.js";
import { pgPool } from "./db/postgres.js";
import {
	resolveTenantProject,
	TenantScopeError,
	trustedTenant,
} from "./tenancy.js";
import { loginRoute, handleLogin } from "./routes/auth.js";
import { otlpIngestRoute, handleOtlpIngest } from "./routes/otlp.js";

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
	createEvaluationRoute,
	handleCreateEvaluation,
	getEvaluationDraftRoute,
	handleGetEvaluationDraft,
	getEvaluationRoute,
	handleGetEvaluation,
	handleListEvaluations,
	handleListEvaluationVersions,
	handleGetEvaluationVersion,
	handleListEvaluationLegacyLinks,
	handlePublishEvaluationDraft,
	handlePutEvaluationDraft,
	listEvaluationsRoute,
	listEvaluationVersionsRoute,
	getEvaluationVersionRoute,
	listEvaluationLegacyLinksRoute,
	publishEvaluationDraftRoute,
	putEvaluationDraftRoute,
} from "./routes/evaluations.js";
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
import {
	archiveProject,
	createProject,
	deleteProject,
	getProjectDeletionStatus,
	getMe,
	getProject,
	handleArchiveProject,
	handleCreateProject,
	handleDeleteProject,
	handleGetProjectDeletionStatus,
	handleGetMe,
	handleGetProject,
	handleGetProjectAuditEvents,
	handleListProjects,
	handleRestoreProject,
	handleUpdateProject,
	handleSetDefaultProject,
	listProjectAuditEvents,
	listProjects,
	restoreProject,
	setDefaultProject,
	updateProject,
} from "./routes/projects.js";
import {
	handleListAdminActors,
	handleListAdminAuditEvents,
	handleListProjectGrants,
	handleRecoverAdmin,
	handleRevokeProjectGrant,
	handleSetAdminActorRole,
	handleSetProjectGrant,
	listAdminActors,
	listAdminAuditEvents,
	listProjectGrants,
	recoverAdmin,
	revokeProjectGrant,
	setAdminActorRole,
	setProjectGrant,
} from "./routes/admin-access.js";
import {
	listBenchmarkSuites,
	createBenchmarkSuiteRoute,
	listBenchmarkRunsRoute,
	createBenchmarkRunRoute,
	handleListBenchmarkSuites,
	handleCreateBenchmarkSuite,
	handleListBenchmarkRuns,
	handleCreateBenchmarkRun,
} from "./routes/benchmarks.js";
import {
	getPromptProvenance,
	handleGetPromptProvenance,
} from "./routes/prompt-provenance.js";
import {
	startOptimization,
	getActiveOptimization,
	getLatestOptimization,
	listOptimizationActivities,
	getOptimization,
	promoteOptimization,
	stopOptimization,
	optimizationEvents,
	handleStart,
	handleGetActive,
	handleGetLatest,
	handleListActivities,
	handleGet,
	handlePromote,
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
	listPublishedDatasetItems,
	handleListPublishedDatasetItems,
	addDatasetItem,
	handleAddDatasetItem,
	deleteDatasetItem,
	handleDeleteDatasetItem,
	getDatasetBySlug,
	handleGetDatasetBySlug,
	patchDatasetBySlug,
	handlePatchDatasetBySlug,
	createDatasetDraft,
	handleCreateDatasetDraft,
	getDatasetDraft,
	handleGetDatasetDraft,
	validateDatasetDraft,
	handleValidateDatasetDraft,
	importDatasetDraftItems,
	handleImportDatasetDraftItems,
	captureDatasetDraftItem,
	handleCaptureDatasetDraftItem,
	reorderDatasetDraftItems,
	handleReorderDatasetDraftItems,
	putDatasetDraftItem,
	handlePutDatasetDraftItem,
	reviewDatasetDraftItem,
	handleReviewDatasetDraftItem,
	listDatasetDraftItemRevisions,
	handleListDatasetDraftItemRevisions,
	deleteDatasetDraftItem,
	handleDeleteDatasetDraftItem,
	archiveDataset,
	handleArchiveDataset,
	restoreDataset,
	handleRestoreDataset,
	tombstoneDataset,
	handleTombstoneDataset,
	exportDataset,
	handleExportDataset,
	discardDatasetDraft,
	handleDiscardDatasetDraft,
	publishDatasetDraft,
	handlePublishDatasetDraft,
	listDatasetVersions,
	handleListDatasetVersions,
	getDatasetVersion,
	handleGetDatasetVersion,
} from "./routes/datasets.js";

import {
	createFeedbackRoute,
	handleCreateFeedback,
	listFeedbackRoute,
	handleListFeedback,
	promoteFeedbackRoute,
	handlePromoteFeedback,
	reviewFeedbackRoute,
	handleReviewFeedback,
} from "./routes/feedback.js";
import {
	approvePolicy,
	createPolicyDraft,
	getEffectivePolicy,
	handleApprovePolicy,
	handleCreatePolicyDraft,
	handleGetEffectivePolicy,
	handleListPolicyHistory,
	handleListRetentionRuns,
	handlePreviewRetention,
	handleRunRetention,
	listRetentionRuns,
	listPolicyHistory,
	previewRetention,
	runRetention,
} from "./routes/governance.js";

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
register(otlpIngestRoute, async (c: Context) => {
	try {
		const scope = await resolveTenantProject(
			pgPool(),
			trustedTenant(c),
			c.req.header("x-astraea-project-id") ?? undefined,
		);
		return handleOtlpIngest(c.req.raw, scope);
	} catch (cause) {
		if (cause instanceof TenantScopeError)
			return c.json(
				{ code: "NOT_FOUND", message: "Project is not available" },
				404,
			);
		throw cause;
	}
});

register(createExperiment, handleCreateExperiment);
register(listExperiments, handleListExperiments);
register(getExperiment, handleGetExperiment);
register(getExperimentResults, handleGetExperimentResults);
register(getExperimentSummary, handleGetExperimentSummary);
register(getExperimentEvents, handleGetExperimentEvents);
register(cancelExperiment, handleCancelExperiment);

register(createEvaluationRoute, handleCreateEvaluation);
register(listEvaluationsRoute, handleListEvaluations);
register(listEvaluationLegacyLinksRoute, handleListEvaluationLegacyLinks);
register(getEvaluationRoute, handleGetEvaluation);
register(getEvaluationDraftRoute, handleGetEvaluationDraft);
register(putEvaluationDraftRoute, handlePutEvaluationDraft);
register(publishEvaluationDraftRoute, handlePublishEvaluationDraft);
register(listEvaluationVersionsRoute, handleListEvaluationVersions);
register(getEvaluationVersionRoute, handleGetEvaluationVersion);

register(listBenchmarkSuites, handleListBenchmarkSuites);
register(createBenchmarkSuiteRoute, handleCreateBenchmarkSuite);
register(listBenchmarkRunsRoute, handleListBenchmarkRuns);
register(createBenchmarkRunRoute, handleCreateBenchmarkRun);

register(listTraces, handleListTraces);
// Register the more specific /v1/traces/events SSE route BEFORE
// /v1/traces/{id} so a literal "events" segment doesn't fall into the
// `{id}` placeholder (which would fail the 32-hex regex validation).
register(streamTraceEvents, handleStreamTraceEvents);
register(getTrace, handleGetTrace);
register(listObservations, handleListObservations);
register(streamObservationEvents, handleStreamObservationEvents);
register(streamTraceDetailEvents, handleStreamTraceDetailEvents);

register(getMe, handleGetMe);
register(listProjects, handleListProjects);
register(createProject, handleCreateProject);
register(setDefaultProject, handleSetDefaultProject);
register(deleteProject, handleDeleteProject);
register(getProjectDeletionStatus, handleGetProjectDeletionStatus);
register(getProject, handleGetProject);
register(updateProject, handleUpdateProject);
register(archiveProject, handleArchiveProject);
register(restoreProject, handleRestoreProject);
register(listProjectAuditEvents, handleGetProjectAuditEvents);
register(listAdminActors, handleListAdminActors);
register(setAdminActorRole, handleSetAdminActorRole);
register(listProjectGrants, handleListProjectGrants);
register(setProjectGrant, handleSetProjectGrant);
register(revokeProjectGrant, handleRevokeProjectGrant);
register(listAdminAuditEvents, handleListAdminAuditEvents);
register(recoverAdmin, handleRecoverAdmin);
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
register(getLatestOptimization, handleGetLatest);
register(listOptimizationActivities, handleListActivities);
register(optimizationEvents, handleEvents);
register(promoteOptimization, handlePromote);
register(stopOptimization, handleStop);
register(getOptimization, handleGet);

register(listDatasets, handleListDatasets);
register(createDataset, handleCreateDataset);
register(getDatasetBySlug, handleGetDatasetBySlug);
register(patchDatasetBySlug, handlePatchDatasetBySlug);
register(createDatasetDraft, handleCreateDatasetDraft);
register(getDatasetDraft, handleGetDatasetDraft);
register(validateDatasetDraft, handleValidateDatasetDraft);
register(importDatasetDraftItems, handleImportDatasetDraftItems);
register(captureDatasetDraftItem, handleCaptureDatasetDraftItem);
register(reorderDatasetDraftItems, handleReorderDatasetDraftItems);
register(putDatasetDraftItem, handlePutDatasetDraftItem);
register(reviewDatasetDraftItem, handleReviewDatasetDraftItem);
register(listDatasetDraftItemRevisions, handleListDatasetDraftItemRevisions);
register(deleteDatasetDraftItem, handleDeleteDatasetDraftItem);
register(archiveDataset, handleArchiveDataset);
register(restoreDataset, handleRestoreDataset);
register(tombstoneDataset, handleTombstoneDataset);
register(exportDataset, handleExportDataset);
register(discardDatasetDraft, handleDiscardDatasetDraft);
register(publishDatasetDraft, handlePublishDatasetDraft);
register(listDatasetVersions, handleListDatasetVersions);
register(getDatasetVersion, handleGetDatasetVersion);
register(getDataset, handleGetDataset);
register(listDatasetItems, handleListDatasetItems);
register(listPublishedDatasetItems, handleListPublishedDatasetItems);
register(addDatasetItem, handleAddDatasetItem);
register(deleteDatasetItem, handleDeleteDatasetItem);

register(createFeedbackRoute, handleCreateFeedback);
register(listFeedbackRoute, handleListFeedback);
register(promoteFeedbackRoute, handlePromoteFeedback);
register(reviewFeedbackRoute, handleReviewFeedback);

register(getEffectivePolicy, handleGetEffectivePolicy);
register(listPolicyHistory, handleListPolicyHistory);
register(createPolicyDraft, handleCreatePolicyDraft);
register(approvePolicy, handleApprovePolicy);
register(previewRetention, handlePreviewRetention);
register(runRetention, handleRunRetention);
register(listRetentionRuns, handleListRetentionRuns);

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
