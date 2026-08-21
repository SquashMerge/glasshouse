import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import { pgPool } from "../db/postgres.js";
import { ch } from "../db/clickhouse.js";
import { logger } from "../lib/logger.js";
import { projectAuthorization } from "../db/project-authorization.js";
import { trustedTenant } from "../tenancy.js";
import {
	createFeedback,
	authorizeFeedbackProject,
	FeedbackRepositoryError,
	getFeedbackPromotionTarget,
	listFeedback,
	promoteFeedback,
	reviewFeedback,
} from "../db/feedback.js";
import {
	Feedback,
	FeedbackCreate,
	FeedbackErrors,
	FeedbackIdParam,
	FeedbackList,
	FeedbackListQuery,
	FeedbackPromotion,
	FeedbackReview,
} from "../schemas/feedback.js";
import { captureTextAsObject } from "../lib/dataset-draft-validation.js";

const errorResponse = (c: Context, cause: unknown) => {
	const error =
		cause instanceof FeedbackRepositoryError
			? cause
			: new FeedbackRepositoryError(
					"INTERNAL",
					"Feedback operation failed",
					cause,
				);
	if (error.status === 500) logger.error("feedback.request_failed", cause);
	return c.json(
		{
			code: error.code,
			message:
				error.status === 500 ? "Feedback operation failed" : error.message,
		},
		error.status,
	);
};
const FeedbackIdempotencyHeader = z.object({
	"idempotency-key": z.string().regex(/^[ -~]{1,200}$/),
});
export const createFeedbackRoute = createRoute({
	method: "post",
	path: "/v1/feedback",
	tags: ["feedback"],
	summary: "Record human trace or Observation feedback",
	security: [{ basicAuth: [] }],
	request: {
		headers: FeedbackIdempotencyHeader,
		body: { content: { "application/json": { schema: FeedbackCreate } } },
	},
	responses: {
		201: {
			description: "Feedback recorded",
			content: { "application/json": { schema: Feedback } },
		},
		...FeedbackErrors,
	},
});
export const listFeedbackRoute = createRoute({
	method: "get",
	path: "/v1/feedback",
	tags: ["feedback"],
	summary: "List project feedback",
	security: [{ basicAuth: [] }],
	request: { query: FeedbackListQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: FeedbackList } },
		},
		...FeedbackErrors,
	},
});
export const reviewFeedbackRoute = createRoute({
	method: "post",
	path: "/v1/feedback/{id}/review",
	tags: ["feedback"],
	summary: "Update feedback review state",
	security: [{ basicAuth: [] }],
	request: {
		params: FeedbackIdParam,
		query: FeedbackListQuery.pick({ project_id: true }),
		body: { content: { "application/json": { schema: FeedbackReview } } },
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: Feedback } },
		},
		...FeedbackErrors,
	},
});
export const promoteFeedbackRoute = createRoute({
	method: "post",
	path: "/v1/feedback/{id}/promote",
	tags: ["feedback"],
	summary: "Explicitly promote reviewed feedback into a dataset",
	security: [{ basicAuth: [] }],
	request: {
		params: FeedbackIdParam,
		query: FeedbackListQuery.pick({ project_id: true }),
		headers: FeedbackIdempotencyHeader,
		body: { content: { "application/json": { schema: FeedbackPromotion } } },
	},
	responses: {
		200: {
			description: "Feedback promoted",
			content: { "application/json": { schema: Feedback } },
		},
		...FeedbackErrors,
	},
});
async function targetExists(input: {
	organization_id: string;
	project_id: string;
	trace_id: string;
	observation_id?: string;
}) {
	const client = ch();
	const table = input.observation_id ? "observations" : "traces";
	const result = await client.query({
		query: `SELECT 1 FROM ${table} WHERE organization_id={organization_id:String} AND project_id={project_id:String} AND trace_id={trace_id:String}${input.observation_id ? " AND observation_id={observation_id:String}" : ""} LIMIT 1`,
		query_params: input,
		format: "JSONEachRow",
	});
	return ((await result.json()) as unknown[]).length > 0;
}
async function captureSource(input: {
	organization_id: string;
	project_id: string;
	trace_id: string;
	observation_id?: string | null;
}) {
	const table = input.observation_id ? "observations" : "traces";
	const result = await ch().query({
		query: `SELECT substring(input_text, 1, 32768) AS input_text, substring(output_text, 1, 32768) AS output_text FROM ${table} WHERE organization_id={organization_id:String} AND project_id={project_id:String} AND trace_id={trace_id:String}${input.observation_id ? " AND observation_id={observation_id:String}" : ""} LIMIT 1`,
		query_params: input.observation_id
			? { ...input, observation_id: input.observation_id }
			: input,
		format: "JSONEachRow",
	});
	const row = ((await result.json()) as Array<Record<string, unknown>>)[0];
	if (!row) return null;
	return {
		input_text: typeof row.input_text === "string" ? row.input_text : "",
		output_text: typeof row.output_text === "string" ? row.output_text : "",
	};
}
export const handleCreateFeedback = async (
	c: Parameters<RouteHandler<typeof createFeedbackRoute>>[0],
) => {
	try {
		const body = c.req.valid("json");
		const tenant = trustedTenant(c);
		const authorization = projectAuthorization(tenant, "product_write");
		const feedback = body.metadata.feedback;
		if (
			(body.value === 1) !== (feedback.sentiment === "positive") ||
			(body.value === -1 && !feedback.reason)
		)
			throw new FeedbackRepositoryError(
				"BAD_REQUEST",
				"Feedback value, sentiment, and reason are invalid",
			);
		await authorizeFeedbackProject(pgPool(), {
			project_id: body.project_id,
			authorization,
		});
		if (
			!(await targetExists({ ...body, organization_id: tenant.organizationId }))
		)
			throw new FeedbackRepositoryError(
				"TARGET_NOT_FOUND",
				"Feedback target not found",
			);
		return c.json(
			await createFeedback(pgPool(), {
				...body,
				idempotency_key: c.req.valid("header")["idempotency-key"],
				authorization,
			}),
			201,
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleListFeedback = async (
	c: Parameters<RouteHandler<typeof listFeedbackRoute>>[0],
) => {
	try {
		return c.json(
			await listFeedback(pgPool(), {
				...c.req.valid("query"),
				authorization: projectAuthorization(trustedTenant(c), "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handlePromoteFeedback = async (
	c: Parameters<RouteHandler<typeof promoteFeedbackRoute>>[0],
) => {
	try {
		const tenant = trustedTenant(c);
		const project_id = c.req.valid("query").project_id;
		const authorization = projectAuthorization(tenant, "product_write");
		const body = c.req.valid("json");
		const idempotency_key = c.req.valid("header")["idempotency-key"];
		const target = await getFeedbackPromotionTarget(pgPool(), {
			project_id,
			id: c.req.valid("param").id,
			...body,
			idempotency_key,
			authorization,
		});
		if (target.kind === "replay") return c.json(target.feedback);
		const source =
			target.status === "added_to_dataset"
				? { input_text: "", output_text: "" }
				: await captureSource({
						organization_id: tenant.organizationId,
						project_id,
						trace_id: target.trace_id,
						observation_id: target.observation_id,
					});
		if (!source)
			throw new FeedbackRepositoryError(
				"TARGET_NOT_FOUND",
				"Feedback target not found",
			);
		return c.json(
			await promoteFeedback(pgPool(), {
				project_id,
				id: c.req.valid("param").id,
				...body,
				captured_input: captureTextAsObject(source.input_text),
				captured_expected_output: source.output_text
					? captureTextAsObject(source.output_text)
					: null,
				idempotency_key,
				authorization,
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleReviewFeedback = async (
	c: Parameters<RouteHandler<typeof reviewFeedbackRoute>>[0],
) => {
	try {
		return c.json(
			await reviewFeedback(pgPool(), {
				project_id: c.req.valid("query").project_id,
				id: c.req.valid("param").id,
				...c.req.valid("json"),
				authorization: projectAuthorization(trustedTenant(c), "product_write"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
