import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import { pgPool } from "../db/postgres.js";
import { ch } from "../db/clickhouse.js";
import {
	addDatasetItem as addDatasetItemRecord,
	createDataset as createDatasetRecord,
	DatasetRepositoryError,
	deleteDatasetItem as deleteDatasetItemRecord,
	getDataset as getDatasetRecord,
	listDatasetItems as listDatasetItemsRecord,
	listDatasets as listDatasetsRecord,
} from "../db/datasets.js";
import {
	Dataset,
	DatasetCreate,
	DatasetErrorResponses,
	DatasetIdParam,
	DatasetItem,
	DatasetItemCreate,
	DatasetItemIdParams,
	DatasetProjectQuery,
} from "../schemas/datasets.js";

const tag = "datasets";
const DatasetList = z
	.object({ items: z.array(Dataset), total: z.number().int().nonnegative() })
	.strict();
const DatasetItemList = z.object({ items: z.array(DatasetItem) }).strict();

const errorResponse = (c: Context, cause: unknown): Response => {
	const error =
		cause instanceof DatasetRepositoryError
			? cause
			: new DatasetRepositoryError(
					"INTERNAL",
					"Dataset operation failed",
					cause,
				);
	return c.json(
		{
			code: error.code,
			message:
				error.code === "INTERNAL" ? "Dataset operation failed" : error.message,
		},
		error.status,
	);
};

export const listDatasets = createRoute({
	method: "get",
	path: "/v1/datasets",
	tags: [tag],
	summary: "List project datasets",
	security: [{ basicAuth: [] }],
	request: { query: DatasetProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: DatasetList } },
		},
		...DatasetErrorResponses,
	},
});
export const createDataset = createRoute({
	method: "post",
	path: "/v1/datasets",
	tags: [tag],
	summary: "Create a project dataset",
	security: [{ basicAuth: [] }],
	request: {
		body: { content: { "application/json": { schema: DatasetCreate } } },
	},
	responses: {
		201: {
			description: "Dataset created",
			content: { "application/json": { schema: Dataset } },
		},
		...DatasetErrorResponses,
	},
});
export const getDataset = createRoute({
	method: "get",
	path: "/v1/datasets/{id}",
	tags: [tag],
	summary: "Get a project dataset",
	security: [{ basicAuth: [] }],
	request: { params: DatasetIdParam, query: DatasetProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Dataset } },
		},
		...DatasetErrorResponses,
	},
});
export const listDatasetItems = createRoute({
	method: "get",
	path: "/v1/datasets/{id}/items",
	tags: [tag],
	summary: "List dataset items",
	security: [{ basicAuth: [] }],
	request: { params: DatasetIdParam, query: DatasetProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: DatasetItemList } },
		},
		...DatasetErrorResponses,
	},
});
export const addDatasetItem = createRoute({
	method: "post",
	path: "/v1/datasets/{id}/items",
	tags: [tag],
	summary: "Add a dataset item, optionally preserving trace provenance",
	security: [{ basicAuth: [] }],
	request: {
		params: DatasetIdParam,
		body: { content: { "application/json": { schema: DatasetItemCreate } } },
	},
	responses: {
		201: {
			description: "Item added",
			content: { "application/json": { schema: DatasetItem } },
		},
		...DatasetErrorResponses,
	},
});
export const deleteDatasetItem = createRoute({
	method: "delete",
	path: "/v1/datasets/{id}/items/{itemId}",
	tags: [tag],
	summary: "Delete a dataset item",
	security: [{ basicAuth: [] }],
	request: { params: DatasetItemIdParams, query: DatasetProjectQuery },
	responses: { 204: { description: "No content" }, ...DatasetErrorResponses },
});

export type DatasetRouteDependencies = {
	pool: typeof pgPool;
	listDatasets: typeof listDatasetsRecord;
	createDataset: typeof createDatasetRecord;
	getDataset: typeof getDatasetRecord;
	listDatasetItems: typeof listDatasetItemsRecord;
	addDatasetItem: typeof addDatasetItemRecord;
	deleteDatasetItem: typeof deleteDatasetItemRecord;
	targetExists: (input: {
		project_id: string;
		trace_id: string;
		observation_id?: string | null;
	}) => Promise<boolean>;
};
async function targetExists(input: {
	project_id: string;
	trace_id: string;
	observation_id?: string | null;
}) {
	const table = input.observation_id ? "observations" : "traces";
	const result = await ch().query({
		query: `SELECT 1 FROM ${table} WHERE project_id={project_id:String} AND trace_id={trace_id:String}${input.observation_id ? " AND observation_id={observation_id:String}" : ""} LIMIT 1`,
		query_params: input.observation_id
			? { ...input, observation_id: input.observation_id }
			: input,
		format: "JSONEachRow",
	});
	return ((await result.json()) as unknown[]).length > 0;
}
const production: DatasetRouteDependencies = {
	pool: pgPool,
	listDatasets: listDatasetsRecord,
	createDataset: createDatasetRecord,
	getDataset: getDatasetRecord,
	listDatasetItems: listDatasetItemsRecord,
	addDatasetItem: addDatasetItemRecord,
	deleteDatasetItem: deleteDatasetItemRecord,
	targetExists,
};

export function createDatasetRouteHandlers(
	dependencies: DatasetRouteDependencies = production,
) {
	return {
		handleListDatasets: async (
			c: Parameters<RouteHandler<typeof listDatasets>>[0],
		) => {
			try {
				return c.json(
					await dependencies.listDatasets(
						dependencies.pool(),
						c.req.valid("query").project_id,
					),
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleCreateDataset: async (
			c: Parameters<RouteHandler<typeof createDataset>>[0],
		) => {
			try {
				return c.json(
					await dependencies.createDataset(
						dependencies.pool(),
						c.req.valid("json"),
					),
					201,
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleGetDataset: async (
			c: Parameters<RouteHandler<typeof getDataset>>[0],
		) => {
			try {
				return c.json(
					await dependencies.getDataset(dependencies.pool(), {
						id: c.req.valid("param").id,
						project_id: c.req.valid("query").project_id,
					}),
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleListDatasetItems: async (
			c: Parameters<RouteHandler<typeof listDatasetItems>>[0],
		) => {
			try {
				return c.json(
					await dependencies.listDatasetItems(dependencies.pool(), {
						dataset_id: c.req.valid("param").id,
						project_id: c.req.valid("query").project_id,
					}),
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleAddDatasetItem: async (
			c: Parameters<RouteHandler<typeof addDatasetItem>>[0],
		) => {
			try {
				const body = c.req.valid("json");
				if (body.source_observation_id && !body.source_trace_id)
					throw new DatasetRepositoryError(
						"BAD_REQUEST",
						"Observation provenance requires a trace",
					);
				if (
					body.source_trace_id &&
					!(await dependencies.targetExists({
						project_id: body.project_id,
						trace_id: body.source_trace_id,
						observation_id: body.source_observation_id,
					}))
				)
					throw new DatasetRepositoryError(
						"NOT_FOUND",
						"Source target not found",
					);
				return c.json(
					await dependencies.addDatasetItem(dependencies.pool(), {
						dataset_id: c.req.valid("param").id,
						...body,
					}),
					201,
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleDeleteDatasetItem: async (
			c: Parameters<RouteHandler<typeof deleteDatasetItem>>[0],
		) => {
			try {
				await dependencies.deleteDatasetItem(dependencies.pool(), {
					dataset_id: c.req.valid("param").id,
					item_id: c.req.valid("param").itemId,
					project_id: c.req.valid("query").project_id,
				});
				return c.body(null, 204);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
	};
}

export const {
	handleListDatasets,
	handleCreateDataset,
	handleGetDataset,
	handleListDatasetItems,
	handleAddDatasetItem,
	handleDeleteDatasetItem,
} = createDatasetRouteHandlers();
