import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
	admitEvaluationRun,
	cancelEvaluationRun,
	EvaluationRunRepositoryError,
	getEvaluationRunExecution,
	getEvaluationRunStatus,
	listEvaluationRunEvents,
	retryEvaluationRun,
	listEvaluationRuns,
	compareEvaluationRuns,
	getEvaluationRunEvidence,
} from "../db/evaluation-runs.js";
import {
	executeEvaluationRun,
	evaluationRunConfig,
	production as evaluationProduction,
} from "./experiments.js";
import {
	createEvaluation,
	EvaluationRepositoryError,
	getEvaluation,
	getEvaluationDraft,
	getEvaluationVersion,
	listEvaluationLegacyLinks,
	listEvaluations,
	listEvaluationsIncludingArchived,
	listEvaluationVersions,
	publishEvaluationDraft,
	updateEvaluationDraft,
	transitionEvaluationLifecycle,
} from "../db/evaluations.js";
import { pgPool } from "../db/postgres.js";
import { projectAuthorization } from "../db/project-authorization.js";
import { logger } from "../lib/logger.js";
import {
	Evaluation,
	EvaluationCreate,
	EvaluationDefinitionInput,
	EvaluationDefinitionVersion,
	EvaluationDraft,
	EvaluationErrorResponses,
	EvaluationRunAdmissionErrorResponses,
	EvaluationLegacyLinkList,
	EvaluationListQuery,
	EvaluationList,
	EvaluationMutationSlugParam,
	EvaluationProjectQuery,
	EvaluationVersionList,
	EvaluationVersionParam,
	EvaluationTombstone,
	EvaluationRun,
	EvaluationRunHeaders,
	EvaluationRunList,
	EvaluationRunListQuery,
	EvaluationRunEvidenceQuery,
	EvaluationRunEvidencePage,
	EvaluationRunCompare,
	EvaluationRunCompareRequest,
	EvaluationRunStart,
	EvaluationRunStatus,
	EvaluationRunIdParam,
	EvaluationRunProjectQuery,
	EvaluationRunEventsHeaders,
	EvaluationSlugParam,
} from "../schemas/evaluations.js";
import { trustedTenant } from "../tenancy.js";
import {
	authorizedSseFrame,
	createAuthorizedSseDelivery,
} from "../lib/authorized-sse.js";

const tag = "evaluations";
const Etag = z.string().regex(/^"\d+"$/);
const IfMatch = z.object({
	"if-match": Etag.openapi({
		param: { name: "if-match", in: "header", required: true },
	}),
});
const errorResponse = (c: Context, cause: unknown) => {
	const error =
		cause instanceof EvaluationRepositoryError
			? cause
			: cause instanceof EvaluationRunRepositoryError
				? cause
				: new EvaluationRepositoryError(
						"INTERNAL",
						"Evaluation operation failed",
						cause,
					);
	if (error.status === 500) logger.error("evaluations.request_failed", cause);
	return c.json(
		{
			code: error.code,
			message:
				error.code === "INTERNAL"
					? "Evaluation operation failed"
					: error.message,
		},
		error.status,
	);
};
export const createEvaluationRoute = createRoute({
	method: "post",
	path: "/v1/evaluations",
	tags: [tag],
	summary: "Create a stable Evaluation and its draft",
	security: [{ basicAuth: [] }],
	request: {
		query: EvaluationProjectQuery,
		body: {
			content: { "application/json": { schema: EvaluationCreate } },
			required: true,
		},
	},
	responses: {
		201: {
			description: "Created",
			content: {
				"application/json": {
					schema: z.object({ evaluation: Evaluation, draft: EvaluationDraft }),
				},
			},
			headers: z.object({ ETag: Etag }),
		},
		...EvaluationErrorResponses,
	},
});
export const listEvaluationsRoute = createRoute({
	method: "get",
	path: "/v1/evaluations",
	tags: [tag],
	summary: "List stable Evaluations",
	security: [{ basicAuth: [] }],
	request: { query: EvaluationListQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: EvaluationList } },
		},
		...EvaluationErrorResponses,
	},
});
export const archiveEvaluationRoute = createRoute({
	method: "delete",
	path: "/v1/evaluations/{slug}",
	tags: [tag],
	summary: "Archive an Evaluation",
	security: [{ basicAuth: [] }],
	request: {
		params: EvaluationMutationSlugParam,
		query: EvaluationProjectQuery,
		headers: IfMatch,
	},
	responses: {
		204: { description: "Archived", headers: z.object({ ETag: Etag }) },
		...EvaluationErrorResponses,
	},
});
export const restoreEvaluationRoute = createRoute({
	method: "post",
	path: "/v1/evaluations/{slug}/restore",
	tags: [tag],
	summary: "Restore an archived Evaluation",
	security: [{ basicAuth: [] }],
	request: {
		params: EvaluationMutationSlugParam,
		query: EvaluationProjectQuery,
		headers: IfMatch,
	},
	responses: {
		204: { description: "Restored", headers: z.object({ ETag: Etag }) },
		...EvaluationErrorResponses,
	},
});
export const tombstoneEvaluationRoute = createRoute({
	method: "delete",
	path: "/v1/evaluations/{slug}/tombstone",
	tags: [tag],
	summary: "Irreversibly tombstone an archived Evaluation",
	description:
		"Retains immutable Definition Versions and content-safe audit evidence; a tombstone cannot be restored or edited.",
	security: [{ basicAuth: [] }],
	request: {
		params: EvaluationMutationSlugParam,
		query: EvaluationProjectQuery,
		headers: IfMatch,
		body: {
			content: { "application/json": { schema: EvaluationTombstone } },
			required: true,
		},
	},
	responses: {
		204: { description: "Tombstoned", headers: z.object({ ETag: Etag }) },
		...EvaluationErrorResponses,
	},
});
export const getEvaluationRoute = createRoute({
	method: "get",
	path: "/v1/evaluations/{slug}",
	tags: [tag],
	summary: "Get an Evaluation",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationSlugParam, query: EvaluationProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Evaluation } },
		},
		...EvaluationErrorResponses,
	},
});
export const getEvaluationDraftRoute = createRoute({
	method: "get",
	path: "/v1/evaluations/{slug}/draft",
	tags: [tag],
	summary: "Get the editable Evaluation definition",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationSlugParam, query: EvaluationProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: EvaluationDraft } },
			headers: z.object({ ETag: Etag }),
		},
		...EvaluationErrorResponses,
	},
});
export const putEvaluationDraftRoute = createRoute({
	method: "put",
	path: "/v1/evaluations/{slug}/draft",
	tags: [tag],
	summary: "Replace an Evaluation definition draft",
	security: [{ basicAuth: [] }],
	request: {
		params: EvaluationMutationSlugParam,
		query: EvaluationProjectQuery,
		headers: IfMatch,
		body: {
			content: { "application/json": { schema: EvaluationDefinitionInput } },
			required: true,
		},
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: EvaluationDraft } },
			headers: z.object({ ETag: Etag }),
		},
		...EvaluationErrorResponses,
	},
});
export const publishEvaluationDraftRoute = createRoute({
	method: "post",
	path: "/v1/evaluations/{slug}/draft/publish",
	tags: [tag],
	summary: "Publish an immutable Evaluation Definition Version",
	security: [{ basicAuth: [] }],
	request: {
		params: EvaluationMutationSlugParam,
		query: EvaluationProjectQuery,
		headers: IfMatch,
	},
	responses: {
		201: {
			description: "Published",
			content: { "application/json": { schema: EvaluationDefinitionVersion } },
		},
		...EvaluationErrorResponses,
	},
});
export const startEvaluationRunRoute = createRoute({
	method: "post",
	path: "/v1/evaluations/{slug}/runs",
	tags: [tag],
	summary: "Admit and start a reproducible Evaluation Run",
	description:
		"Resolves an immutable Definition Version and Dataset Version snapshot before any work is queued. Admission accepts only an exact operator-allowed provider/model pair and snapshots active-run, requested sample-size, and provider-call bounds. Active limits are 1-32 per Project and actor; the requested sample-size and provider-call limits are 1-10,000 per Run. The sample-size limit is checked before Dataset items are materialized. Retries with the same Idempotency-Key replay the original run.",
	security: [{ basicAuth: [] }],
	request: {
		params: EvaluationMutationSlugParam,
		query: EvaluationProjectQuery,
		headers: EvaluationRunHeaders,
		body: {
			content: { "application/json": { schema: EvaluationRunStart } },
			required: true,
		},
	},
	responses: {
		202: {
			description: "Run admitted and queued",
			content: { "application/json": { schema: EvaluationRun } },
		},
		...EvaluationRunAdmissionErrorResponses,
	},
});
export const listEvaluationRunsRoute = createRoute({
	method: "get",
	path: "/v1/evaluation-runs",
	tags: [tag],
	summary: "List inspectable Evaluation Runs",
	security: [{ basicAuth: [] }],
	request: { query: EvaluationRunListQuery },
	responses: {
		200: {
			description: "Authorized run summaries",
			content: { "application/json": { schema: EvaluationRunList } },
		},
		...EvaluationErrorResponses,
	},
});
export const compareEvaluationRunsRoute = createRoute({
	method: "post",
	path: "/v1/evaluation-runs/compare",
	tags: [tag],
	summary: "Compare two compatible Evaluation Runs",
	description:
		"Returns explicit pinned-input differences and refuses score/cost deltas when the runs are not comparable.",
	security: [{ basicAuth: [] }],
	request: {
		query: EvaluationRunProjectQuery,
		body: {
			content: { "application/json": { schema: EvaluationRunCompareRequest } },
			required: true,
		},
	},
	responses: {
		200: {
			description: "Comparison or incompatibility explanation",
			content: { "application/json": { schema: EvaluationRunCompare } },
		},
		...EvaluationErrorResponses,
	},
});
export const getEvaluationRunEvidenceRoute = createRoute({
	method: "get",
	path: "/v1/evaluation-runs/{id}/evidence",
	tags: [tag],
	summary: "Read bounded Evaluation Run evidence",
	security: [{ basicAuth: [] }],
	request: {
		params: EvaluationRunIdParam,
		query: EvaluationRunEvidenceQuery,
	},
	responses: {
		200: {
			description: "Project-scoped evidence page",
			content: { "application/json": { schema: EvaluationRunEvidencePage } },
		},
		...EvaluationErrorResponses,
	},
});
export const getEvaluationRunRoute = createRoute({
	method: "get",
	path: "/v1/evaluation-runs/{id}",
	tags: [tag],
	summary: "Get durable Evaluation Run status",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationRunIdParam, query: EvaluationRunProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: EvaluationRunStatus } },
		},
		...EvaluationErrorResponses,
	},
});
export const cancelEvaluationRunRoute = createRoute({
	method: "post",
	path: "/v1/evaluation-runs/{id}/cancel",
	tags: [tag],
	summary: "Cancel a durable Evaluation Run",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationRunIdParam, query: EvaluationRunProjectQuery },
	responses: {
		200: {
			description: "Cancelled",
			content: { "application/json": { schema: EvaluationRunStatus } },
		},
		...EvaluationErrorResponses,
	},
});
export const retryEvaluationRunRoute = createRoute({
	method: "post",
	path: "/v1/evaluation-runs/{id}/retry",
	tags: [tag],
	summary: "Retry failed items in a durable Evaluation Run",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationRunIdParam, query: EvaluationRunProjectQuery },
	responses: {
		202: {
			description: "Retry queued",
			content: { "application/json": { schema: EvaluationRunStatus } },
		},
		...EvaluationErrorResponses,
	},
});
export const getEvaluationRunEventsRoute = createRoute({
	method: "get",
	path: "/v1/evaluation-runs/{id}/events",
	tags: [tag],
	summary: "Stream replayable durable Evaluation Run events",
	security: [{ basicAuth: [] }],
	request: {
		params: EvaluationRunIdParam,
		query: EvaluationRunProjectQuery,
		headers: EvaluationRunEventsHeaders,
	},
	responses: {
		200: {
			description: "OK (text/event-stream)",
			content: { "text/event-stream": { schema: z.string() } },
		},
		...EvaluationErrorResponses,
	},
});

export const listEvaluationVersionsRoute = createRoute({
	method: "get",
	path: "/v1/evaluations/{slug}/versions",
	tags: [tag],
	summary: "List immutable Evaluation Definition Versions",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationSlugParam, query: EvaluationProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: EvaluationVersionList } },
		},
		...EvaluationErrorResponses,
	},
});
export const getEvaluationVersionRoute = createRoute({
	method: "get",
	path: "/v1/evaluations/{slug}/versions/{version}",
	tags: [tag],
	summary: "Get an immutable Evaluation Definition Version",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationVersionParam, query: EvaluationProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: EvaluationDefinitionVersion } },
		},
		...EvaluationErrorResponses,
	},
});
export const listEvaluationLegacyLinksRoute = createRoute({
	method: "get",
	path: "/v1/evaluations/compatibility",
	tags: [tag],
	summary: "List structural legacy evaluation compatibility links",
	security: [{ basicAuth: [] }],
	request: { query: EvaluationProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: EvaluationLegacyLinkList } },
		},
		...EvaluationErrorResponses,
	},
});
const revision = (value: string | undefined) => {
	const match = value?.match(/^"(\d+)"$/);
	if (!match)
		throw new EvaluationRepositoryError(
			"BAD_REQUEST",
			"If-Match must contain the current Evaluation draft revision",
		);
	return Number(match[1]);
};
const authorization = (
	c: Context,
	operation: "product_read" | "curation_write" | "execute" | "destructive",
) => projectAuthorization(trustedTenant(c), operation);
export const handleCreateEvaluation = async (c: any) => {
	try {
		const body = c.req.valid("json");
		const value = await createEvaluation(pgPool(), {
			...body,
			project_id: c.req.valid("query").project_id,
			authorization: authorization(c, "curation_write"),
		});
		c.header("ETag", `\"${value.draft.revision}\"`);
		return c.json(value, 201);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleListEvaluations = async (c: any) => {
	try {
		const query = c.req.valid("query");
		return c.json(
			await (query.include_archived
				? listEvaluationsIncludingArchived(pgPool(), {
						project_id: query.project_id,
						authorization: authorization(c, "destructive"),
					})
				: listEvaluations(pgPool(), {
						project_id: query.project_id,
						authorization: authorization(c, "product_read"),
					})),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
async function lifecycle(c: any, action: "archive" | "restore" | "tombstone") {
	const slug = c.req.valid("param").slug;
	if (action === "tombstone" && c.req.valid("json").confirmation_slug !== slug)
		throw new EvaluationRepositoryError(
			"BAD_REQUEST",
			"confirmation_slug must match the Evaluation stable ID",
		);
	const value = await transitionEvaluationLifecycle(pgPool(), {
		project_id: c.req.valid("query").project_id,
		slug,
		revision: revision(c.req.header("if-match")),
		action,
		authorization: authorization(c, "destructive"),
	});
	c.header("ETag", `\"${value.lifecycle_revision}\"`);
	return c.body(null, 204);
}
export const handleArchiveEvaluation = async (c: any) => {
	try {
		return await lifecycle(c, "archive");
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleRestoreEvaluation = async (c: any) => {
	try {
		return await lifecycle(c, "restore");
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleTombstoneEvaluation = async (c: any) => {
	try {
		return await lifecycle(c, "tombstone");
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleGetEvaluation = async (c: any) => {
	try {
		return c.json(
			await getEvaluation(pgPool(), {
				project_id: c.req.valid("query").project_id,
				slug: c.req.valid("param").slug,
				authorization: authorization(c, "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleGetEvaluationDraft = async (c: any) => {
	try {
		const value = await getEvaluationDraft(pgPool(), {
			project_id: c.req.valid("query").project_id,
			slug: c.req.valid("param").slug,
			authorization: authorization(c, "product_read"),
		});
		c.header("ETag", `\"${value.revision}\"`);
		return c.json(value);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handlePutEvaluationDraft = async (c: any) => {
	try {
		const value = await updateEvaluationDraft(pgPool(), {
			project_id: c.req.valid("query").project_id,
			slug: c.req.valid("param").slug,
			revision: revision(c.req.header("if-match")),
			definition: c.req.valid("json"),
			authorization: authorization(c, "curation_write"),
		});
		c.header("ETag", `\"${value.revision}\"`);
		return c.json(value);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handlePublishEvaluationDraft = async (c: any) => {
	try {
		return c.json(
			await publishEvaluationDraft(pgPool(), {
				project_id: c.req.valid("query").project_id,
				slug: c.req.valid("param").slug,
				revision: revision(c.req.header("if-match")),
				authorization: authorization(c, "curation_write"),
			}),
			201,
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleStartEvaluationRun = async (c: any) => {
	try {
		const query = c.req.valid("query");
		const params = c.req.valid("param");
		const body = c.req.valid("json");
		const headers = c.req.valid("header");
		const run = await admitEvaluationRun(pgPool(), {
			project_id: query.project_id,
			evaluation_selector: params.slug,
			definition_version: body.definition_version,
			idempotency_key: headers["idempotency-key"],
			trigger_metadata: body.trigger_metadata,
			authorization: projectAuthorization(trustedTenant(c), "execute"),
		});
		if (!run.replayed)
			void executeEvaluationRun(evaluationProduction, {
				project_id: run.project_id,
				experiment_id: run.experiment_id,
				evaluation_run_id: run.id,
				dataset_id: run.dataset_id,
				config: evaluationRunConfig(run.snapshot),
			}).catch((cause) =>
				logger.error("evaluation.run_execution_failed", cause, {
					run_id: run.id,
					experiment_id: run.experiment_id,
					project_id: run.project_id,
				}),
			);
		return c.json(run, 202);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};

export const handleListEvaluationRuns = async (c: any) => {
	try {
		const query = c.req.valid("query");
		return c.json(
			await listEvaluationRuns(pgPool(), {
				...query,
				authorization: authorization(c, "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};

export const handleCompareEvaluationRuns = async (c: any) => {
	try {
		const query = c.req.valid("query");
		const body = c.req.valid("json");
		return c.json(
			await compareEvaluationRuns(pgPool(), {
				project_id: query.project_id,
				run_ids: body.run_ids as [string, string],
				authorization: authorization(c, "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};

export const handleGetEvaluationRunEvidence = async (c: any) => {
	try {
		const params = c.req.valid("param");
		const query = c.req.valid("query");
		return c.json(
			await getEvaluationRunEvidence(pgPool(), {
				id: params.id,
				project_id: query.project_id,
				limit: query.limit,
				offset: query.offset,
				authorization: projectAuthorization(trustedTenant(c), "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};

export const handleGetEvaluationRun = async (c: any) => {
	try {
		return c.json(
			await getEvaluationRunStatus(pgPool(), {
				id: c.req.valid("param").id,
				project_id: c.req.valid("query").project_id,
				authorization: authorization(c, "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};

export const handleCancelEvaluationRun = async (c: any) => {
	try {
		const query = c.req.valid("query");
		const status = await cancelEvaluationRun(pgPool(), {
			id: c.req.valid("param").id,
			project_id: query.project_id,
			authorization: authorization(c, "execute"),
		});
		return c.json(status);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};

export const handleRetryEvaluationRun = async (c: any) => {
	try {
		const query = c.req.valid("query");
		const status = await retryEvaluationRun(pgPool(), {
			id: c.req.valid("param").id,
			project_id: query.project_id,
			authorization: authorization(c, "execute"),
		});
		const execution = await getEvaluationRunExecution(pgPool(), {
			id: c.req.valid("param").id,
			project_id: query.project_id,
			authorization: authorization(c, "execute"),
		});
		void executeEvaluationRun(evaluationProduction, {
			...execution,
			evaluation_run_id: execution.id,
		}).catch((cause) =>
			logger.error("evaluation.run_retry_execution_failed", cause, {
				run_id: c.req.valid("param").id,
				project_id: query.project_id,
			}),
		);
		return c.json(status, 202);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};

export const handleGetEvaluationRunEvents = async (c: any) => {
	try {
		const params = c.req.valid("param");
		const query = c.req.valid("query");
		const headers = c.req.valid("header");
		const projectAuthorization = authorization(c, "product_read");
		await getEvaluationRunStatus(pgPool(), {
			id: params.id,
			project_id: query.project_id,
			authorization: projectAuthorization,
		});
		let afterId = headers["last-event-id"] ?? 0;
		return streamSSE(c, async (stream) => {
			let closed = false;
			let polling = false;
			let timer: ReturnType<typeof setInterval> | undefined;
			let resolveClose = () => {};
			const waitForClose = new Promise<void>((resolve) => {
				resolveClose = resolve;
			});
			const close = () => {
				if (closed) return;
				closed = true;
				if (timer) clearInterval(timer);
				resolveClose();
			};
			stream.onAbort(close);
			const delivery = createAuthorizedSseDelivery({
				stream,
				pool: pgPool,
				tenant: trustedTenant(c),
				projectId: query.project_id,
				onClose: close,
			});
			const tick = async () => {
				if (closed || polling) return;
				polling = true;
				try {
					const events = await listEvaluationRunEvents(pgPool(), {
						id: params.id,
						project_id: query.project_id,
						after_id: afterId,
						authorization: projectAuthorization,
					});
					for (const event of events) {
						const data = JSON.stringify({
							...event.payload,
							run_id: event.run_id,
							task_id: event.task_id,
							created_at: event.created_at,
						});
						if (
							!(await delivery.deliver(
								authorizedSseFrame(data, () =>
									stream.writeSSE({
										id: String(event.id),
										event: event.event_type,
										data,
									}),
								),
							))
						)
							return;
						afterId = event.id;
					}
					const status = await getEvaluationRunStatus(pgPool(), {
						id: params.id,
						project_id: query.project_id,
						authorization: projectAuthorization,
					});
					if (["completed", "failed", "cancelled"].includes(status.status))
						close();
				} catch {
					close();
				} finally {
					polling = false;
				}
			};
			if (
				!(await delivery.deliver(
					authorizedSseFrame(":ok\n\n", () => stream.write(":ok\n\n")),
				))
			)
				return;
			timer = setInterval(() => void tick(), 500);
			void tick();
			await waitForClose;
		});
	} catch (cause) {
		return errorResponse(c, cause);
	}
};

export const handleListEvaluationVersions = async (c: any) => {
	try {
		return c.json(
			await listEvaluationVersions(pgPool(), {
				project_id: c.req.valid("query").project_id,
				slug: c.req.valid("param").slug,
				authorization: projectAuthorization(trustedTenant(c), "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleGetEvaluationVersion = async (c: any) => {
	try {
		return c.json(
			await getEvaluationVersion(pgPool(), {
				project_id: c.req.valid("query").project_id,
				...c.req.valid("param"),
				authorization: authorization(c, "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleListEvaluationLegacyLinks = async (c: any) => {
	try {
		return c.json(
			await listEvaluationLegacyLinks(pgPool(), {
				project_id: c.req.valid("query").project_id,
				authorization: authorization(c, "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
