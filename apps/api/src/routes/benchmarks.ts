import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import { pgPool } from "../db/postgres.js";
import {
	admitEvaluationRun,
	EvaluationRunRepositoryError,
} from "../db/evaluation-runs.js";
import {
	DatasetRepositoryError,
	listPublishedDatasetItems,
} from "../db/datasets.js";
import {
	createBenchmarkSuite,
	getBenchmarkSuite,
	listBenchmarkRuns,
	listBenchmarkSuites as listBenchmarkSuitesRecord,
	BenchmarkRepositoryError,
} from "../db/benchmarks.js";
import {
	BenchmarkErrorResponses,
	BenchmarkProjectQuery,
	BenchmarkRanking,
	BenchmarkRun,
	BenchmarkRunCreate,
	BenchmarkSuite,
	BenchmarkSuiteCreate,
	BenchmarkSuiteIdParam,
} from "../schemas/benchmarks.js";
import {
	executeExperiment,
	production,
	type ExperimentDependencies,
} from "./experiments.js";
import { logger } from "../lib/logger.js";
import { projectAuthorization } from "../db/project-authorization.js";
import { trustedTenant } from "../tenancy.js";

const tag = "benchmarks";
const SuiteList = z
	.object({
		items: z.array(BenchmarkSuite),
		total: z.number().int().nonnegative(),
	})
	.strict()
	.openapi("BenchmarkSuiteList");
const errorResponse = (c: Context, cause: unknown): Response => {
	const error =
		cause instanceof BenchmarkRepositoryError
			? cause
			: cause instanceof EvaluationRunRepositoryError
				? cause
				: new BenchmarkRepositoryError(
						"INTERNAL",
						"Benchmark operation failed",
						cause,
					);
	if (error.status === 500) logger.error("benchmarks.request_failed", cause);
	return c.json(
		{
			code: error.code,
			message:
				error.code === "INTERNAL"
					? "Benchmark operation failed"
					: error.message,
		},
		error.status,
	);
};

async function requirePublishedGoldenDataset(
	input: Parameters<typeof listPublishedDatasetItems>[1],
) {
	try {
		const items = await listPublishedDatasetItems(pgPool(), input);
		if (
			!items.items.length ||
			items.items.some((item) => item.expected_output == null)
		)
			throw new BenchmarkRepositoryError(
				"BAD_REQUEST",
				"Golden benchmark datasets require expected_output for every item",
			);
		return items;
	} catch (cause) {
		if (cause instanceof DatasetRepositoryError && cause.code === "NOT_FOUND")
			throw new BenchmarkRepositoryError(
				"NOT_FOUND",
				"Dataset not found",
				cause,
			);
		throw cause;
	}
}

export const listBenchmarkSuites = createRoute({
	method: "get",
	path: "/v1/benchmarks",
	tags: [tag],
	summary: "List benchmark suites",
	security: [{ basicAuth: [] }],
	request: { query: BenchmarkProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: SuiteList } },
		},
		...BenchmarkErrorResponses,
	},
});
export const createBenchmarkSuiteRoute = createRoute({
	method: "post",
	path: "/v1/benchmarks",
	tags: [tag],
	summary: "Create a golden-dataset benchmark suite",
	security: [{ basicAuth: [] }],
	request: {
		body: { content: { "application/json": { schema: BenchmarkSuiteCreate } } },
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: BenchmarkSuite } },
		},
		...BenchmarkErrorResponses,
	},
});
export const listBenchmarkRunsRoute = createRoute({
	method: "get",
	path: "/v1/benchmarks/{id}/runs",
	tags: [tag],
	summary: "Rank benchmark runs",
	security: [{ basicAuth: [] }],
	request: { params: BenchmarkSuiteIdParam, query: BenchmarkProjectQuery },
	responses: {
		200: {
			description: "Ranking",
			content: { "application/json": { schema: BenchmarkRanking } },
		},
		...BenchmarkErrorResponses,
	},
});
export const createBenchmarkRunRoute = createRoute({
	method: "post",
	path: "/v1/benchmarks/{id}/runs",
	tags: [tag],
	summary: "Run a prompt/model benchmark",
	security: [{ basicAuth: [] }],
	request: {
		params: BenchmarkSuiteIdParam,
		query: BenchmarkProjectQuery,
		body: { content: { "application/json": { schema: BenchmarkRunCreate } } },
	},
	responses: {
		202: {
			description: "Benchmark started",
			content: { "application/json": { schema: BenchmarkRun } },
		},
		...BenchmarkErrorResponses,
	},
});

export const handleListBenchmarkSuites = async (
	c: Parameters<RouteHandler<typeof listBenchmarkSuites>>[0],
) => {
	try {
		return c.json(
			await listBenchmarkSuitesRecord(pgPool(), {
				project_id: c.req.valid("query").project_id,
				authorization: projectAuthorization(trustedTenant(c), "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleCreateBenchmarkSuite = async (
	c: Parameters<RouteHandler<typeof createBenchmarkSuiteRoute>>[0],
) => {
	try {
		const body = c.req.valid("json");
		const authorization = projectAuthorization(
			trustedTenant(c),
			"product_write",
		);
		await requirePublishedGoldenDataset({
			project_id: body.project_id,
			dataset_id: body.dataset_id,
			authorization,
		});
		return c.json(
			await createBenchmarkSuite(pgPool(), {
				...body,
				authorization,
			}),
			201,
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleListBenchmarkRuns = async (
	c: Parameters<RouteHandler<typeof listBenchmarkRunsRoute>>[0],
) => {
	try {
		return c.json(
			await listBenchmarkRuns(pgPool(), {
				project_id: c.req.valid("query").project_id,
				suite_id: c.req.valid("param").id,
				authorization: projectAuthorization(trustedTenant(c), "product_read"),
			}),
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};
export const handleCreateBenchmarkRun = async (
	c: Parameters<RouteHandler<typeof createBenchmarkRunRoute>>[0],
) => {
	try {
		const project_id = c.req.valid("query").project_id;
		const suite_id = c.req.valid("param").id;
		const body = c.req.valid("json");
		const suite = await getBenchmarkSuite(pgPool(), {
			project_id,
			id: suite_id,
			authorization: projectAuthorization(trustedTenant(c), "execute"),
		});
		const authorization = projectAuthorization(trustedTenant(c), "execute");
		const hasAdmissionInputs =
			body.evaluation_id !== undefined &&
			body.definition_version !== undefined &&
			body.idempotency_key !== undefined;
		if (!hasAdmissionInputs)
			throw new BenchmarkRepositoryError(
				"CONFLICT",
				"Benchmark runs now require an Evaluation Definition Version and idempotency_key",
			);
		if (Object.keys(body.config).length > 0)
			throw new BenchmarkRepositoryError(
				"CONFLICT",
				"Benchmark target configuration must come from the pinned Evaluation Definition Version",
			);
		if (
			body.evaluation_id === undefined ||
			body.definition_version === undefined ||
			body.idempotency_key === undefined
		)
			throw new BenchmarkRepositoryError(
				"CONFLICT",
				"Benchmark runs now require an Evaluation Definition Version and idempotency_key",
			);
		const run = await admitEvaluationRun(pgPool(), {
			project_id,
			evaluation_selector: body.evaluation_id,
			definition_version: body.definition_version,
			idempotency_key: body.idempotency_key,
			expected_dataset_id: suite.dataset_id,
			benchmark: {
				suite_id,
				label: body.label,
				model: body.model ?? null,
				prompt_version: body.prompt_version ?? null,
			},
			authorization,
		});
		const config = {
			...run.snapshot.target,
			evaluator: run.snapshot.evaluator.kind,
			...run.snapshot.execution_defaults,
		};
		if (!run.replayed)
			void executeBenchmarkExperiment({
				project_id,
				experiment_id: run.experiment_id,
				dataset_id: run.dataset_id,
				config,
			});
		return c.json(
			{
				id: run.benchmark_run_id,
				project_id,
				suite_id,
				experiment_id: run.experiment_id,
				label: body.label,
				model: body.model ?? run.snapshot.target.model,
				prompt_version: body.prompt_version ?? null,
				created_at: run.created_at,
			},
			202,
		);
	} catch (cause) {
		return errorResponse(c, cause);
	}
};

export async function executeBenchmarkExperiment(
	input: Parameters<typeof executeExperiment>[1],
	dependencies: ExperimentDependencies = production,
	executor: typeof executeExperiment = executeExperiment,
) {
	try {
		await executor(dependencies, input);
	} catch (cause) {
		logger.error("benchmark.failed", cause, {
			experiment_id: input.experiment_id,
			project_id: input.project_id,
		});
		try {
			await dependencies.updateExperiment(dependencies.pool(), {
				project_id: input.project_id,
				id: input.experiment_id,
				status: "failed",
				if_status: ["pending", "running"],
			});
		} catch (updateCause) {
			logger.error("benchmark.failure_status_update_failed", updateCause, {
				experiment_id: input.experiment_id,
				project_id: input.project_id,
			});
		}
	}
}
