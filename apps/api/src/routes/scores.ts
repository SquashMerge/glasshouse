import { createRoute } from "@hono/zod-openapi";
import { Score, ScoreCreate, ScoreStubResponses } from "../schemas/scores.js";
import { IdParam } from "../schemas/common.js";
import { notImplemented } from "./_stub.js";

const tag = "scores";

export const createScore = createRoute({
	method: "post",
	path: "/v1/scores",
	tags: [tag],
	summary: "Record a score",
	request: {
		body: { content: { "application/json": { schema: ScoreCreate } } },
	},
	responses: {
		201: {
			description: "Score recorded",
			content: { "application/json": { schema: Score } },
		},
		...ScoreStubResponses,
	},
});
export const handleCreateScore = () => notImplemented();

export const getScore = createRoute({
	method: "get",
	path: "/v1/scores/{id}",
	tags: [tag],
	summary: "Get a score",
	request: { params: IdParam },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Score } },
		},
		...ScoreStubResponses,
	},
});
export const handleGetScore = (_id: string) => notImplemented();
