import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
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
	EvaluationSlugParam,
	EvaluationLegacyLinkList,
	EvaluationListQuery,
	EvaluationList,
	EvaluationProjectQuery,
	EvaluationVersionList,
	EvaluationVersionParam,
	EvaluationTombstone,
} from "../schemas/evaluations.js";
import { trustedTenant } from "../tenancy.js";

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
		body: { content: { "application/json": { schema: EvaluationCreate } } },
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
		params: EvaluationSlugParam,
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
		params: EvaluationSlugParam,
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
		params: EvaluationSlugParam,
		query: EvaluationProjectQuery,
		headers: IfMatch,
		body: { content: { "application/json": { schema: EvaluationTombstone } } },
	},
	responses: {
		204: { description: "Tombstoned" },
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
		params: EvaluationSlugParam,
		query: EvaluationProjectQuery,
		headers: IfMatch,
		body: {
			content: { "application/json": { schema: EvaluationDefinitionInput } },
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
		params: EvaluationSlugParam,
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
	operation: "product_read" | "curation_write" | "destructive",
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
export const handleListEvaluationVersions = async (c: any) => {
	try {
		return c.json(
			await listEvaluationVersions(pgPool(), {
				project_id: c.req.valid("query").project_id,
				slug: c.req.valid("param").slug,
				authorization: authorization(c, "product_read"),
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
