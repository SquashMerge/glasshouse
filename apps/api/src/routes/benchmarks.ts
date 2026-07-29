import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import { pgPool } from "../db/postgres.js";
import { listDatasetItems } from "../db/datasets.js";
import {
	createBenchmarkRun,
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
			: new BenchmarkRepositoryError(
					"INTERNAL",
					"Benchmark operation failed",
					cause,
				);
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
			await listBenchmarkSuitesRecord(
				pgPool(),
				c.req.valid("query").project_id,
			),
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
		const items = await listDatasetItems(pgPool(), {
			project_id: body.project_id,
			dataset_id: body.dataset_id,
		});
		if (
			!items.items.length ||
			items.items.some((item) => item.expected_output == null)
		)
			throw new BenchmarkRepositoryError(
				"BAD_REQUEST",
				"Golden benchmark datasets require expected_output for every item",
			);
		return c.json(await createBenchmarkSuite(pgPool(), body), 201);
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
		});
		const config = { ...body.config, model: body.model ?? body.config.model };
		const experiment = await production.createExperiment(pgPool(), {
			project_id,
			dataset_id: suite.dataset_id,
			name: `benchmark:${body.label}`,
			config,
		});
		const run = await createBenchmarkRun(pgPool(), {
			project_id,
			suite_id,
			experiment_id: experiment.id,
			label: body.label,
			model: body.model ?? null,
			prompt_version: body.prompt_version ?? null,
		});
		void executeBenchmarkExperiment({
			project_id,
			experiment_id: experiment.id,
			dataset_id: suite.dataset_id,
			config,
		});
		return c.json(run, 202);
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
		logger.error("benchmark.failed", undefined, {
			error_type: cause instanceof Error ? cause.name : typeof cause,
			experiment_id: input.experiment_id,
			project_id: input.project_id,
		});
		try {
			await dependencies.updateExperiment(dependencies.pool(), {
				project_id: input.project_id,
				id: input.experiment_id,
				status: "failed",
			});
		} catch (updateCause) {
			logger.error("benchmark.failure_status_update_failed", undefined, {
				error_type:
					updateCause instanceof Error ? updateCause.name : typeof updateCause,
				experiment_id: input.experiment_id,
				project_id: input.project_id,
			});
		}
	}
}
