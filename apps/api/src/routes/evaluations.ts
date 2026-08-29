import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
	createEvaluation,
	EvaluationRepositoryError,
	getEvaluation,
	getEvaluationDraft,
	listEvaluations,
	listEvaluationVersions,
	publishEvaluationDraft,
	updateEvaluationDraft,
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
	EvaluationIdParam,
	EvaluationList,
	EvaluationProjectQuery,
	EvaluationVersionList,
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
	request: { query: EvaluationProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: EvaluationList } },
		},
		...EvaluationErrorResponses,
	},
});
export const getEvaluationRoute = createRoute({
	method: "get",
	path: "/v1/evaluations/{id}",
	tags: [tag],
	summary: "Get an Evaluation",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationIdParam, query: EvaluationProjectQuery },
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
	path: "/v1/evaluations/{id}/draft",
	tags: [tag],
	summary: "Get the editable Evaluation definition",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationIdParam, query: EvaluationProjectQuery },
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
	path: "/v1/evaluations/{id}/draft",
	tags: [tag],
	summary: "Replace an Evaluation definition draft",
	security: [{ basicAuth: [] }],
	request: {
		params: EvaluationIdParam,
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
	path: "/v1/evaluations/{id}/draft/publish",
	tags: [tag],
	summary: "Publish an immutable Evaluation Definition Version",
	security: [{ basicAuth: [] }],
	request: {
		params: EvaluationIdParam,
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
	path: "/v1/evaluations/{id}/versions",
	tags: [tag],
	summary: "List immutable Evaluation Definition Versions",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationIdParam, query: EvaluationProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: EvaluationVersionList } },
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
	operation: "product_read" | "curation_write",
) => projectAuthorization(trustedTenant(c), operation);
export const handleCreateEvaluation = async (c: any) => {
	try {
		const body = c.req.valid("json");
		const value = await createEvaluation(pgPool(), {
			...body,
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
		return c.json(
			await listEvaluations(pgPool(), {
				project_id: c.req.valid("query").project_id,
				authorization: authorization(c, "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleGetEvaluation = async (c: any) => {
	try {
		return c.json(
			await getEvaluation(pgPool(), {
				project_id: c.req.valid("query").project_id,
				id: c.req.valid("param").id,
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
			id: c.req.valid("param").id,
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
			id: c.req.valid("param").id,
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
				id: c.req.valid("param").id,
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
				id: c.req.valid("param").id,
				authorization: authorization(c, "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
