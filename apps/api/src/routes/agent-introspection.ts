import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
	AgentIntrospectionRepositoryError,
	getAgentIntrospectionReport,
	storeAgentIntrospectionReport,
} from "../db/agent-introspection.js";
import { pgPool } from "../db/postgres.js";
import { projectAuthorization } from "../db/project-authorization.js";
import { logger } from "../lib/logger.js";
import {
	AgentIntrospectionErrorResponses,
	AgentIntrospectionPath,
	AgentIntrospectionProjectQuery,
	AgentIntrospectionReportV1,
	ReadAgentIntrospectionReportV1,
	StoredAgentIntrospectionReportV1,
} from "../schemas/agent-introspection.js";
import { trustedTenant } from "../tenancy.js";

const tag = "agent-introspection";
const NoStore = z.object({ "Cache-Control": z.literal("no-store") });
export const putAgentIntrospectionRoute = createRoute({
	method: "put",
	path: "/v1/evaluation-runs/{run_id}/tasks/{task_id}/agent-introspection/{invocation_id}",
	tags: [tag],
	summary: "Store or replay a client-reported Agent Introspection Report",
	description:
		"Stores one immutable references-only client report. Astraea did not execute or verify the reported agent activity.",
	security: [{ basicAuth: [] }],
	request: {
		params: AgentIntrospectionPath,
		query: AgentIntrospectionProjectQuery,
		body: {
			content: { "application/json": { schema: AgentIntrospectionReportV1 } },
			required: true,
		},
	},
	responses: {
		201: {
			description: "Stored",
			headers: NoStore,
			content: {
				"application/json": { schema: StoredAgentIntrospectionReportV1 },
			},
		},
		200: {
			description: "Identical immutable replay",
			headers: NoStore,
			content: {
				"application/json": { schema: StoredAgentIntrospectionReportV1 },
			},
		},
		...AgentIntrospectionErrorResponses,
	},
});
export const getAgentIntrospectionRoute = createRoute({
	method: "get",
	path: "/v1/evaluation-runs/{run_id}/tasks/{task_id}/agent-introspection/{invocation_id}",
	tags: [tag],
	summary: "Get one client-reported Agent Introspection Report",
	description:
		"Returns supplementary client-reported evidence, not verified agent execution.",
	security: [{ basicAuth: [] }],
	request: {
		params: AgentIntrospectionPath,
		query: AgentIntrospectionProjectQuery,
	},
	responses: {
		200: {
			description: "OK",
			headers: NoStore,
			content: {
				"application/json": { schema: ReadAgentIntrospectionReportV1 },
			},
		},
		...AgentIntrospectionErrorResponses,
	},
});

function failure(c: Context, cause: unknown) {
	const error =
		cause instanceof AgentIntrospectionRepositoryError
			? cause
			: new AgentIntrospectionRepositoryError(
					"INTERNAL",
					"Agent introspection operation failed",
					cause,
				);
	if (error.status === 500)
		logger.error("agent_introspection.request_failed", cause);
	return c.json(
		{
			code: error.code,
			message:
				error.code === "PAYLOAD_TOO_LARGE"
					? "Report exceeds the normalized size limit"
					: error.code === "INTERNAL"
						? "Agent introspection operation failed"
						: error.message,
		},
		error.status,
	);
}

function identity(c: any, operation: "ingest" | "product_read") {
	const params = c.req.valid("param");
	const query = c.req.valid("query");
	return {
		project_id: query.project_id,
		run_id: params.run_id,
		task_id: params.task_id,
		invocation_id: params.invocation_id,
		authorization: projectAuthorization(trustedTenant(c), operation),
	};
}

export const handlePutAgentIntrospection = async (c: any) => {
	try {
		const stored = await storeAgentIntrospectionReport(
			pgPool(),
			identity(c, "ingest"),
			c.req.valid("json"),
		);
		c.header("Cache-Control", "no-store");
		return c.json(
			{ ...stored.report, replayed: stored.replayed },
			stored.created ? 201 : 200,
		);
	} catch (cause) {
		c.header("Cache-Control", "no-store");
		return failure(c, cause);
	}
};
export const handleGetAgentIntrospection = async (c: any) => {
	try {
		const stored = await getAgentIntrospectionReport(
			pgPool(),
			identity(c, "product_read"),
		);
		c.header("Cache-Control", "no-store");
		return c.json(stored);
	} catch (cause) {
		c.header("Cache-Control", "no-store");
		return failure(c, cause);
	}
};
