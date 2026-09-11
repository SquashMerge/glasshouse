import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
	admitEvaluationGate,
	createEvaluationGateApproval,
	getEvaluationGateApproval,
	getEvaluationGateRun,
	listEvaluationGateApprovalHistory,
	listEvaluationGateApprovals,
	listEvaluationGateRuns,
	revokeEvaluationGateApproval,
} from "../db/evaluation-gates.js";
import { pgPool } from "../db/postgres.js";
import { projectAuthorization } from "../db/project-authorization.js";
import { logger } from "../lib/logger.js";
import {
	evaluationRunConfig,
	executeEvaluationRun,
	production as evaluationProduction,
} from "./experiments.js";
import { trustedTenant } from "../tenancy.js";
import {
	EvaluationGateApproval,
	EvaluationGateApprovalCreate,
	EvaluationGateApprovalList,
	EvaluationGateApprovalHistory,
	EvaluationGateApprovalListQuery,
	EvaluationGateApprovalRevoke,
	EvaluationGateErrorResponses,
	EvaluationGateIdParam,
	EvaluationGateRun,
	EvaluationGateRunHeaders,
	EvaluationGateRunList,
	EvaluationGateRunListQuery,
	EvaluationGateRunStart,
} from "../schemas/evaluation-gates.js";
import { EvaluationGateRepositoryError } from "../db/evaluation-gates.js";

const tag = "evaluation-gates";
const ProjectQuery = z.object({ project_id: z.string().uuid() }).strict();

function ok(schema: z.ZodType) {
	return {
		200: { description: "OK", content: { "application/json": { schema } } },
		...EvaluationGateErrorResponses,
	};
}

export const createEvaluationGateApprovalRoute = createRoute({
	method: "post",
	path: "/v1/evaluation-gates/approvals",
	tags: [tag],
	summary: "Approve an immutable Evaluation Definition Version for a gate",
	description:
		"Only a Project Admin can approve a complete typed Definition Version with a pinned threshold. The approval never follows mutable latest state.",
	security: [{ basicAuth: [] }],
	request: {
		query: ProjectQuery,
		body: {
			content: { "application/json": { schema: EvaluationGateApprovalCreate } },
			required: true,
		},
	},
	responses: {
		201: {
			description: "Approved",
			content: { "application/json": { schema: EvaluationGateApproval } },
		},
		...EvaluationGateErrorResponses,
	},
});
export const listEvaluationGateApprovalsRoute = createRoute({
	method: "get",
	path: "/v1/evaluation-gates/approvals",
	tags: [tag],
	summary: "List Evaluation Gate approvals",
	security: [{ basicAuth: [] }],
	request: { query: EvaluationGateApprovalListQuery },
	responses: ok(EvaluationGateApprovalList),
});
export const getEvaluationGateApprovalRoute = createRoute({
	method: "get",
	path: "/v1/evaluation-gates/approvals/{id}",
	tags: [tag],
	summary: "Inspect an Evaluation Gate approval",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationGateIdParam, query: ProjectQuery },
	responses: ok(EvaluationGateApproval),
});
export const listEvaluationGateApprovalHistoryRoute = createRoute({
	method: "get",
	path: "/v1/evaluation-gates/approvals/{id}/history",
	tags: [tag],
	summary: "Inspect safe Evaluation Gate approval history",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationGateIdParam, query: ProjectQuery },
	responses: ok(EvaluationGateApprovalHistory),
});
export const revokeEvaluationGateApprovalRoute = createRoute({
	method: "post",
	path: "/v1/evaluation-gates/approvals/{id}/revoke",
	tags: [tag],
	summary: "Revoke an Evaluation Gate approval",
	security: [{ basicAuth: [] }],
	request: {
		params: EvaluationGateIdParam,
		query: ProjectQuery,
		body: {
			content: { "application/json": { schema: EvaluationGateApprovalRevoke } },
			required: true,
		},
	},
	responses: ok(EvaluationGateApproval),
});

export const startEvaluationGateRoute = createRoute({
	method: "post",
	path: "/v1/evaluation-gates/runs",
	tags: [tag],
	summary: "Run an administrator-approved pinned Evaluation Gate",
	description:
		"Requires an explicit active approval, Definition Version UUID, Dataset Version UUID, context, and idempotency key. The result never deploys or mutates production.",
	security: [{ basicAuth: [] }],
	request: {
		query: ProjectQuery,
		headers: EvaluationGateRunHeaders,
		body: {
			content: { "application/json": { schema: EvaluationGateRunStart } },
			required: true,
		},
	},
	responses: {
		202: {
			description: "Gate Run admitted",
			content: { "application/json": { schema: EvaluationGateRun } },
		},
		...EvaluationGateErrorResponses,
	},
});
export const listEvaluationGateRunsRoute = createRoute({
	method: "get",
	path: "/v1/evaluation-gates/runs",
	tags: [tag],
	summary: "List Evaluation Gate Runs",
	security: [{ basicAuth: [] }],
	request: { query: EvaluationGateRunListQuery },
	responses: ok(EvaluationGateRunList),
});
export const getEvaluationGateRunRoute = createRoute({
	method: "get",
	path: "/v1/evaluation-gates/runs/{id}",
	tags: [tag],
	summary: "Inspect an Evaluation Gate Run outcome",
	security: [{ basicAuth: [] }],
	request: { params: EvaluationGateIdParam, query: ProjectQuery },
	responses: ok(EvaluationGateRun),
});

function failure(c: Context, cause: unknown): Response {
	if (cause instanceof EvaluationGateRepositoryError) {
		if (cause.status === 500)
			logger.error("evaluation_gate.request_failed", cause);
		return c.json(
			{
				code: cause.code,
				message:
					cause.status === 500
						? "Evaluation Gate operation failed"
						: cause.message,
			},
			cause.status,
		);
	}
	logger.error("evaluation_gate.request_failed", cause);
	return c.json(
		{ code: "INTERNAL", message: "Evaluation Gate operation failed" },
		500,
	);
}

export const handleCreateEvaluationGateApproval = async (c: any) => {
	try {
		const query = c.req.valid("query");
		const body = c.req.valid("json");
		const value = await createEvaluationGateApproval(pgPool(), {
			...query,
			...body,
			authorization: projectAuthorization(
				trustedTenant(c),
				"release_gate_manage",
			),
		});
		return c.json(value, 201);
	} catch (cause) {
		return failure(c, cause);
	}
};
export const handleListEvaluationGateApprovals = async (c: any) => {
	try {
		const query = c.req.valid("query");
		return c.json(
			await listEvaluationGateApprovals(pgPool(), {
				...query,
				authorization: projectAuthorization(trustedTenant(c), "product_read"),
			}),
		);
	} catch (cause) {
		return failure(c, cause);
	}
};
export const handleGetEvaluationGateApproval = async (c: any) => {
	try {
		const params = c.req.valid("param");
		const query = c.req.valid("query");
		return c.json(
			await getEvaluationGateApproval(pgPool(), {
				id: params.id,
				project_id: query.project_id,
				authorization: projectAuthorization(trustedTenant(c), "product_read"),
			}),
		);
	} catch (cause) {
		return failure(c, cause);
	}
};
export const handleListEvaluationGateApprovalHistory = async (c: any) => {
	try {
		const params = c.req.valid("param");
		const query = c.req.valid("query");
		return c.json(
			await listEvaluationGateApprovalHistory(pgPool(), {
				approval_id: params.id,
				project_id: query.project_id,
				authorization: projectAuthorization(trustedTenant(c), "product_read"),
			}),
		);
	} catch (cause) {
		return failure(c, cause);
	}
};
export const handleRevokeEvaluationGateApproval = async (c: any) => {
	try {
		const params = c.req.valid("param");
		const query = c.req.valid("query");
		const body = c.req.valid("json");
		return c.json(
			await revokeEvaluationGateApproval(pgPool(), {
				id: params.id,
				project_id: query.project_id,
				reason: body.reason,
				authorization: projectAuthorization(
					trustedTenant(c),
					"release_gate_manage",
				),
			}),
		);
	} catch (cause) {
		return failure(c, cause);
	}
};

export const handleStartEvaluationGate = async (c: any) => {
	try {
		const query = c.req.valid("query");
		const body = c.req.valid("json");
		const headers = c.req.valid("header");
		const authorization = projectAuthorization(
			trustedTenant(c),
			"release_gate_manage",
		);
		const admitted = await admitEvaluationGate(pgPool(), {
			project_id: query.project_id,
			approval_id: body.approval_id,
			definition_version_id: body.definition_version_id,
			dataset_version_id: body.dataset_version_id,
			gate_context: body.gate_context,
			idempotency_key: headers["idempotency-key"],
			trigger_metadata: body.trigger_metadata,
			authorization,
		});
		if (!admitted.run.replayed)
			void executeEvaluationRun(evaluationProduction, {
				project_id: admitted.run.project_id,
				experiment_id: admitted.run.experiment_id,
				evaluation_run_id: admitted.run.id,
				dataset_id: admitted.run.dataset_id,
				config: evaluationRunConfig(admitted.run.snapshot),
			}).catch((cause) =>
				logger.error("evaluation_gate.run_execution_failed", cause, {
					gate_run_id: admitted.gate.id,
					run_id: admitted.run.id,
					project_id: admitted.run.project_id,
				}),
			);
		return c.json(admitted.gate, 202);
	} catch (cause) {
		return failure(c, cause);
	}
};
export const handleListEvaluationGateRuns = async (c: any) => {
	try {
		const query = c.req.valid("query");
		return c.json(
			await listEvaluationGateRuns(pgPool(), {
				...query,
				authorization: projectAuthorization(trustedTenant(c), "product_read"),
			}),
		);
	} catch (cause) {
		return failure(c, cause);
	}
};
export const handleGetEvaluationGateRun = async (c: any) => {
	try {
		const params = c.req.valid("param");
		const query = c.req.valid("query");
		return c.json(
			await getEvaluationGateRun(pgPool(), {
				id: params.id,
				project_id: query.project_id,
				authorization: projectAuthorization(trustedTenant(c), "product_read"),
			}),
		);
	} catch (cause) {
		return failure(c, cause);
	}
};
