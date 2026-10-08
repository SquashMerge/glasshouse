import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { openapiApp } from "./openapi.js";
import { handleHealth } from "./routes/health.js";
import {
	authenticationMiddleware,
	PUBLIC_API_ROUTES,
} from "./middleware/auth.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { bodySizeLimit, parseBodySizeLimit } from "./middleware/body-size.js";
import { handleOtlpIngest, resourceProjectIds } from "./routes/otlp.js";
import { authenticationPool, pgPool } from "./db/postgres.js";
import { listRecoverableExperiments } from "./db/experiments.js";
import { cancelInterruptedExecutionAdmissions } from "./db/execution-admissions.js";
import { failInterruptedOptimizationJobs } from "./db/prompt-optimizations.js";
import { failInterruptedRetentionRuns } from "./db/governance.js";
import {
	executeExperiment,
	executeEvaluationRun,
	production as evaluationProduction,
} from "./routes/experiments.js";
import { recoverInterruptedWork } from "./lib/recovery.js";
import {
	assertTenantProjectAccess,
	resolveTenantProject,
	TenantScopeError,
	trustedTenant,
} from "./tenancy.js";
import type { ProjectOperation } from "./authorization-policy.js";
import { logger } from "./lib/logger.js";
import { AuthenticationError } from "./db/local-sessions.js";

const PORT = Number(process.env.API_PORT ?? 3000);
const MAX_BODY_BYTES = parseBodySizeLimit(process.env.API_MAX_BODY_BYTES);
const AGENT_INTROSPECTION_PATH =
	"/v1/evaluation-runs/:run_id/tasks/:task_id/agent-introspection/:invocation_id";

export type ApiDependencies = {
	handleHealth: typeof handleHealth;
	handleOtlpIngest: typeof handleOtlpIngest;
	pgPool: typeof pgPool;
	assertTenantProjectAccess: typeof assertTenantProjectAccess;
	resolveTenantProject: typeof resolveTenantProject;
	authenticate: typeof authenticationMiddleware;
	authenticationPool: typeof authenticationPool;
};

const productionApiDependencies: ApiDependencies = {
	handleHealth,
	handleOtlpIngest,
	pgPool,
	assertTenantProjectAccess,
	resolveTenantProject,
	authenticate: authenticationMiddleware,
	authenticationPool,
};

function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		)
	);
}

function isJsonContentType(contentType: string | undefined): boolean {
	return (
		contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
	);
}

function projectOperationForRequest(
	path: string,
	method: string,
): ProjectOperation {
	if (path.startsWith("/v1/prompts/")) {
		if (method === "POST" && /^\/v1\/prompts\/[^/]+\/render$/.test(path))
			return "product_read";
		if (method === "DELETE" && /^\/v1\/prompts\/[^/]+$/.test(path))
			return "destructive";
		if (
			method === "POST" &&
			/^\/v1\/prompts\/[^/]+\/versions\/rollback$/.test(path)
		)
			return "destructive";
	}
	if (path.startsWith("/v1/datasets/")) {
		if (
			(method === "DELETE" && /^\/v1\/datasets\/by-slug\/[^/]+$/.test(path)) ||
			/^\/v1\/datasets\/by-slug\/[^/]+\/(?:export|restore|tombstone)$/.test(
				path,
			)
		)
			return "destructive";
		if (method === "GET" || method === "HEAD") return "product_read";
		return "curation_write";
	}
	if (path.startsWith("/v1/evaluation-gates/")) {
		if (method === "GET" || method === "HEAD") return "product_read";
		return "release_gate_manage";
	}
	if (
		method === "PUT" &&
		/^\/v1\/evaluation-runs\/[^/]+\/tasks\/[^/]+\/agent-introspection\/[^/]+$/.test(
			path,
		)
	)
		return "ingest";
	if (method === "GET" || method === "HEAD") return "product_read";
	if (path === "/v1/datasets") return "curation_write";
	if (path.startsWith("/v1/feedback")) return "curation_write";
	if (path.startsWith("/v1/governance/")) return "governed";
	if (path.startsWith("/v1/prompt-optimizations/") && path.endsWith("/promote"))
		return "governed";
	if (path === "/v1/evaluation-runs/compare") return "product_read";
	if (
		(path.startsWith("/v1/evaluations/") && path.endsWith("/runs")) ||
		path.startsWith("/v1/experiments") ||
		path.startsWith("/v1/prompt-optimizations") ||
		path.includes("/benchmark-runs") ||
		(path.startsWith("/v1/benchmarks/") && path.endsWith("/runs"))
	)
		return "execute";
	return "product_write";
}

async function requestedProjectIds(c: {
	req: {
		header: (name: string) => string | undefined;
		path: string;
		query: (name: string) => string | undefined;
		raw: Request;
	};
}): Promise<ReadonlySet<string>> {
	const projectIds = new Set<string>();
	const addProjectId = (candidate: unknown) => {
		if (isUuid(candidate)) projectIds.add(candidate.toLowerCase());
	};

	addProjectId(c.req.query("project_id"));
	addProjectId(c.req.query("filter[project_id]"));
	if (
		c.req.path === "/v1/otel/v1/traces" ||
		!isJsonContentType(c.req.header("content-type"))
	)
		return projectIds;
	try {
		const body = (await c.req.raw.clone().json()) as Record<string, unknown>;
		addProjectId(body.project_id);
	} catch {
		// Route-level validation owns malformed or non-JSON request bodies.
	}
	return projectIds;
}

export function createApiApp(dependencies: Partial<ApiDependencies> = {}) {
	const resolvedDependencies: ApiDependencies = {
		...productionApiDependencies,
		...dependencies,
	};
	const apiApp = new Hono();

	apiApp.use("*", async (c, next) => {
		const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
		c.header("x-request-id", requestId);
		const startedAt = performance.now();
		try {
			await next();
		} finally {
			const durationMs = Math.round(performance.now() - startedAt);
			const fields = {
				request_id: requestId,
				method: c.req.method,
				path: c.req.path,
				status: c.res.status,
				duration_ms: durationMs,
			};
			if (c.req.path === "/health" || c.req.path === "/v1/health")
				logger.debug("http.request", fields);
			else if (c.res.status >= 500)
				logger.error("http.request.failed", undefined, fields);
			else if (c.res.status >= 400)
				logger.warn("http.request.rejected", fields);
			else logger.info("http.request", fields);
		}
	});
	apiApp.onError((error, c) => {
		if (
			error instanceof AuthenticationError ||
			(error instanceof HTTPException &&
				[400, 415].includes(error.status) &&
				c.req.path.startsWith("/v1/auth/"))
		)
			return c.json(
				{ code: "UNAUTHORIZED", message: "Authentication required" },
				401,
			);
		logger.error("http.unhandled_error", error, {
			method: c.req.method,
			path: c.req.path,
		});
		return c.json({ code: "INTERNAL", message: "Internal server error" }, 500);
	});

	apiApp.use(securityHeaders());
	apiApp.use(AGENT_INTROSPECTION_PATH, async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	// Body size limit applied before auth so unauth'd large payloads don't waste auth work.
	apiApp.use(bodySizeLimit(MAX_BODY_BYTES));

	apiApp.get("/health", () => resolvedDependencies.handleHealth());
	apiApp.get("/v1/health", () => resolvedDependencies.handleHealth());

	apiApp.use("/v1/prompts/*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	apiApp.use("/v1/prompt-provenance/*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	apiApp.use("/v1/prompt-optimizations/*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	apiApp.use(
		"*",
		resolvedDependencies.authenticate(
			resolvedDependencies.pgPool,
			resolvedDependencies.authenticationPool,
		),
	);
	apiApp.use("/v1/*", async (c, next) => {
		try {
			if (
				c.req.path === "/v1/me" ||
				c.req.path.startsWith("/v1/auth/") ||
				PUBLIC_API_ROUTES.has(`${c.req.method} ${c.req.path}`) ||
				c.req.path === "/v1/otel/v1/traces" ||
				c.req.path.startsWith("/v1/projects") ||
				c.req.path.startsWith("/v1/admin/") ||
				c.req.path.startsWith("/v1/organization/")
			)
				return await next();
			const projectIds = await requestedProjectIds(c);
			if (projectIds.size > 1)
				throw new TenantScopeError("Conflicting project selectors");
			if (projectIds.size === 0)
				throw new TenantScopeError("Project target is required");
			const operation = projectOperationForRequest(c.req.path, c.req.method);
			for (const projectId of projectIds)
				await resolvedDependencies.assertTenantProjectAccess(
					resolvedDependencies.pgPool(),
					trustedTenant(c),
					projectId,
					operation,
				);
			await next();
		} catch (cause) {
			if (
				cause instanceof TenantScopeError &&
				cause.message === "Project target is required"
			)
				return c.json(
					{ code: "BAD_REQUEST", message: "Request validation failed" },
					400,
				);
			if (cause instanceof TenantScopeError)
				return c.json(
					{ code: "NOT_FOUND", message: "Project is not available" },
					404,
				);
			throw cause;
		}
	});

	// OTLP is mounted as a raw handler (not via openapiApp) because it consumes
	// the raw JSON body and returns a non-typed OTLP response shape.
	apiApp.post("/v1/otel/v1/traces", async (c) => {
		try {
			const tenant = trustedTenant(c);
			const header = c.req.header("x-glasshouse-project-id");
			if (!header || !isUuid(header))
				throw new TenantScopeError("Project target is required");
			const requestedProjectId = header;
			const resourceProjects = await resourceProjectIds(c.req.raw);
			const scope = await resolvedDependencies.resolveTenantProject(
				resolvedDependencies.pgPool(),
				tenant,
				requestedProjectId,
				"ingest",
			);
			if (
				requestedProjectId &&
				[...resourceProjects].some((projectId) => projectId !== scope.projectId)
			)
				throw new TenantScopeError(
					"Project is not available to this organization",
				);
			return resolvedDependencies.handleOtlpIngest(
				c.req.raw,
				scope,
				scope.projectId,
			);
		} catch (cause) {
			if (cause instanceof TenantScopeError) {
				return c.json(
					{ code: "NOT_FOUND", message: "Project is not available" },
					404,
				);
			}
			throw cause;
		}
	});

	apiApp.route("/", openapiApp);
	return apiApp;
}

const apiApp = createApiApp();

if (import.meta.main) {
	await recoverInterruptedWork({
		pool: pgPool,
		cancelAdmissions: () => cancelInterruptedExecutionAdmissions(pgPool()),
		recoverExperiments: () => listRecoverableExperiments(pgPool()),
		failOptimizations: () => failInterruptedOptimizationJobs(pgPool()),
		failRetentionRuns: () => failInterruptedRetentionRuns(pgPool()),
		resumeExperiment: async (experiment) => {
			const execution = experiment.evaluation_run_id
				? executeEvaluationRun(evaluationProduction, {
						project_id: experiment.project_id,
						experiment_id: experiment.id,
						evaluation_run_id: experiment.evaluation_run_id,
						dataset_id: experiment.dataset_id,
						config: experiment.config,
					})
				: executeExperiment(evaluationProduction, {
						project_id: experiment.project_id,
						experiment_id: experiment.id,
						dataset_id: experiment.dataset_id,
						config: experiment.config,
					});
			void execution.catch((cause) =>
				logger.error("evaluation.recovery_failed", cause, {
					experiment_id: experiment.id,
					project_id: experiment.project_id,
				}),
			);
		},
		log: logger.info,
	});
}

logger.info("api.started", {
	port: PORT,
	host: "0.0.0.0",
	log_level: process.env.LOG_LEVEL ?? "info",
});
logger.info("api.routes_ready", {
	openapi: `/openapi.json`,
	reference: `/reference`,
	health: `/health`,
	otlp_ingest: "/v1/otel/v1/traces",
});

export default {
	port: PORT,
	hostname: "0.0.0.0",
	fetch: apiApp.fetch,
};
