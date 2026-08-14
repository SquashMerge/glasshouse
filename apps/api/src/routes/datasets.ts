import { createRoute, z, type RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import { pgPool } from "../db/postgres.js";
import { ch } from "../db/clickhouse.js";
import { logger } from "../lib/logger.js";
import { trustedTenant } from "../tenancy.js";
import { projectAuthorization } from "../db/project-authorization.js";
import {
	addDatasetItem as addDatasetItemRecord,
	authorizeDatasetWrite as authorizeDatasetWriteRecord,
	createDataset as createDatasetRecord,
	discardDatasetDraft as discardDatasetDraftRecord,
	publishDatasetDraft as publishDatasetDraftRecord,
	DatasetRepositoryError,
	deleteDatasetItem as deleteDatasetItemRecord,
	deleteDatasetDraftItem as deleteDatasetDraftItemRecord,
	archiveDataset as archiveDatasetRecord,
	getDatasetBySlug as getDatasetBySlugRecord,
	getDatasetDraft as getDatasetDraftRecord,
	getOrCreateDatasetDraft as getOrCreateDatasetDraftRecord,
	getDataset as getDatasetRecord,
	listDatasetItems as listDatasetItemsRecord,
	listDatasets as listDatasetsRecord,
	updateDatasetMetadata as updateDatasetMetadataRecord,
	upsertDatasetDraftItem as upsertDatasetDraftItemRecord,
} from "../db/datasets.js";
import {
	Dataset,
	DatasetCreate,
	DatasetErrorResponses,
	DatasetIdParam,
	DatasetItem,
	DatasetItemCreate,
	DatasetItemIdParams,
	DatasetDraft,
	DatasetDraftItem,
	DatasetDraftItemParam,
	DatasetDraftItemUpsert,
	DatasetMetadataUpdate,
	DatasetProjectQuery,
	DatasetDraftPublish,
	DatasetSlugParam,
} from "../schemas/datasets.js";

const tag = "datasets";
const DatasetList = z
	.object({ items: z.array(Dataset), total: z.number().int().nonnegative() })
	.strict();
const DatasetItemList = z.object({ items: z.array(DatasetItem) }).strict();
const DraftRevisionEtag = z
	.string()
	.regex(/^"\d+"$/)
	.openapi({
		description: "Quoted current draft revision for optimistic concurrency.",
		example: '"3"',
	});
const DraftRevisionHeaders = z.object({ ETag: DraftRevisionEtag });
const IfMatchDraftRevision = z.object({
	"if-match": DraftRevisionEtag.openapi({
		param: {
			name: "if-match",
			in: "header",
			required: true,
			description:
				"Quoted draft revision returned by the latest draft ETag response.",
		},
	}),
});

const errorResponse = (c: Context, cause: unknown): Response => {
	const error =
		cause instanceof DatasetRepositoryError
			? cause
			: new DatasetRepositoryError(
					"INTERNAL",
					"Dataset operation failed",
					cause,
				);
	if (error.status === 500) logger.error("datasets.request_failed", cause);
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
	summary: "Legacy dataset item write endpoint",
	deprecated: true,
	security: [{ basicAuth: [] }],
	request: {
		params: DatasetIdParam,
		body: { content: { "application/json": { schema: DatasetItemCreate } } },
	},
	responses: { ...DatasetErrorResponses },
});
export const deleteDatasetItem = createRoute({
	method: "delete",
	path: "/v1/datasets/{id}/items/{itemId}",
	tags: [tag],
	summary: "Legacy dataset item write endpoint",
	deprecated: true,
	security: [{ basicAuth: [] }],
	request: { params: DatasetItemIdParams, query: DatasetProjectQuery },
	responses: { ...DatasetErrorResponses },
});
export const getDatasetBySlug = createRoute({
	method: "get",
	path: "/v1/datasets/by-slug/{slug}",
	tags: [tag],
	summary: "Get a dataset by stable slug",
	security: [{ basicAuth: [] }],
	request: { params: DatasetSlugParam, query: DatasetProjectQuery },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Dataset } },
		},
		...DatasetErrorResponses,
	},
});
export const patchDatasetBySlug = createRoute({
	method: "patch",
	path: "/v1/datasets/by-slug/{slug}",
	tags: [tag],
	summary: "Update dataset metadata",
	security: [{ basicAuth: [] }],
	request: {
		params: DatasetSlugParam,
		query: DatasetProjectQuery,
		body: {
			content: { "application/json": { schema: DatasetMetadataUpdate } },
		},
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: Dataset } },
		},
		...DatasetErrorResponses,
	},
});
export const createDatasetDraft = createRoute({
	method: "post",
	path: "/v1/datasets/by-slug/{slug}/drafts",
	tags: [tag],
	summary: "Create or get the shared dataset draft",
	security: [{ basicAuth: [] }],
	request: { params: DatasetSlugParam, query: DatasetProjectQuery },
	responses: {
		200: {
			description: "Draft",
			headers: DraftRevisionHeaders,
			content: { "application/json": { schema: DatasetDraft } },
		},
		...DatasetErrorResponses,
	},
});
export const getDatasetDraft = createRoute({
	method: "get",
	path: "/v1/datasets/by-slug/{slug}/draft",
	tags: [tag],
	summary: "Get the shared dataset draft",
	security: [{ basicAuth: [] }],
	request: { params: DatasetSlugParam, query: DatasetProjectQuery },
	responses: {
		200: {
			description: "Draft",
			headers: DraftRevisionHeaders,
			content: { "application/json": { schema: DatasetDraft } },
		},
		...DatasetErrorResponses,
	},
});
export const putDatasetDraftItem = createRoute({
	method: "put",
	path: "/v1/datasets/by-slug/{slug}/draft/items/{itemKey}",
	tags: [tag],
	summary: "Upsert a draft item using its stable key",
	security: [{ basicAuth: [] }],
	request: {
		params: DatasetDraftItemParam,
		query: DatasetProjectQuery,
		headers: IfMatchDraftRevision,
		body: {
			content: { "application/json": { schema: DatasetDraftItemUpsert } },
		},
	},
	responses: {
		200: {
			description: "Draft item",
			headers: DraftRevisionHeaders,
			content: { "application/json": { schema: DatasetDraftItem } },
		},
		...DatasetErrorResponses,
	},
});
export const deleteDatasetDraftItem = createRoute({
	method: "delete",
	path: "/v1/datasets/by-slug/{slug}/draft/items/{itemKey}",
	tags: [tag],
	summary: "Delete a draft item using its stable key",
	security: [{ basicAuth: [] }],
	request: {
		params: DatasetDraftItemParam,
		query: DatasetProjectQuery,
		headers: IfMatchDraftRevision,
	},
	responses: {
		204: { description: "Draft item deleted", headers: DraftRevisionHeaders },
		...DatasetErrorResponses,
	},
});
export const archiveDataset = createRoute({
	method: "delete",
	path: "/v1/datasets/by-slug/{slug}",
	tags: [tag],
	summary: "Archive a dataset",
	security: [{ basicAuth: [] }],
	request: { params: DatasetSlugParam, query: DatasetProjectQuery },
	responses: { 204: { description: "Archived" }, ...DatasetErrorResponses },
});
export const discardDatasetDraft = createRoute({
	method: "post",
	path: "/v1/datasets/by-slug/{slug}/draft/discard",
	tags: [tag],
	summary: "Discard the shared dataset draft",
	security: [{ basicAuth: [] }],
	request: { params: DatasetSlugParam, query: DatasetProjectQuery },
	responses: { 204: { description: "Discarded" }, ...DatasetErrorResponses },
});
export const publishDatasetDraft = createRoute({
	method: "post",
	path: "/v1/datasets/by-slug/{slug}/draft/publish",
	tags: [tag],
	summary: "Publish the shared dataset draft",
	security: [{ basicAuth: [] }],
	request: {
		params: DatasetSlugParam,
		query: DatasetProjectQuery,
		headers: IfMatchDraftRevision,
	},
	responses: {
		200: {
			description: "Published",
			content: { "application/json": { schema: DatasetDraftPublish } },
		},
		...DatasetErrorResponses,
	},
});

export type DatasetRouteDependencies = {
	pool: typeof pgPool;
	listDatasets: typeof listDatasetsRecord;
	createDataset: typeof createDatasetRecord;
	getDataset: typeof getDatasetRecord;
	listDatasetItems: typeof listDatasetItemsRecord;
	addDatasetItem: typeof addDatasetItemRecord;
	deleteDatasetItem: typeof deleteDatasetItemRecord;
	getDatasetBySlug: typeof getDatasetBySlugRecord;
	updateDatasetMetadata: typeof updateDatasetMetadataRecord;
	getOrCreateDatasetDraft: typeof getOrCreateDatasetDraftRecord;
	getDatasetDraft: typeof getDatasetDraftRecord;
	upsertDatasetDraftItem: typeof upsertDatasetDraftItemRecord;
	deleteDatasetDraftItem: typeof deleteDatasetDraftItemRecord;
	authorizeDatasetWrite: typeof authorizeDatasetWriteRecord;
	archiveDataset: typeof archiveDatasetRecord;
	discardDatasetDraft: typeof discardDatasetDraftRecord;
	publishDatasetDraft: typeof publishDatasetDraftRecord;
	targetExists: (input: {
		organization_id: string;
		project_id: string;
		trace_id: string;
		observation_id?: string | null;
	}) => Promise<boolean>;
};
async function targetExists(input: {
	organization_id: string;
	project_id: string;
	trace_id: string;
	observation_id?: string | null;
}) {
	const table = input.observation_id ? "observations" : "traces";
	const result = await ch().query({
		query: `SELECT 1 FROM ${table} WHERE organization_id={organization_id:String} AND project_id={project_id:String} AND trace_id={trace_id:String}${input.observation_id ? " AND observation_id={observation_id:String}" : ""} LIMIT 1`,
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
	getDatasetBySlug: getDatasetBySlugRecord,
	updateDatasetMetadata: updateDatasetMetadataRecord,
	getOrCreateDatasetDraft: getOrCreateDatasetDraftRecord,
	getDatasetDraft: getDatasetDraftRecord,
	upsertDatasetDraftItem: upsertDatasetDraftItemRecord,
	deleteDatasetDraftItem: deleteDatasetDraftItemRecord,
	authorizeDatasetWrite: authorizeDatasetWriteRecord,
	archiveDataset: archiveDatasetRecord,
	discardDatasetDraft: discardDatasetDraftRecord,
	publishDatasetDraft: publishDatasetDraftRecord,
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
					await dependencies.listDatasets(dependencies.pool(), {
						project_id: c.req.valid("query").project_id,
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_read",
						),
					}),
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleGetDatasetBySlug: async (
			c: Parameters<RouteHandler<typeof getDatasetBySlug>>[0],
		) => {
			try {
				return c.json(
					await dependencies.getDatasetBySlug(dependencies.pool(), {
						project_id: c.req.valid("query").project_id,
						slug: c.req.valid("param").slug,
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_read",
						),
					}),
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handlePatchDatasetBySlug: async (
			c: Parameters<RouteHandler<typeof patchDatasetBySlug>>[0],
		) => {
			try {
				return c.json(
					await dependencies.updateDatasetMetadata(dependencies.pool(), {
						project_id: c.req.valid("query").project_id,
						slug: c.req.valid("param").slug,
						...c.req.valid("json"),
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_write",
						),
					}),
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleCreateDatasetDraft: async (
			c: Parameters<RouteHandler<typeof createDatasetDraft>>[0],
		) => {
			try {
				const value = await dependencies.getOrCreateDatasetDraft(
					dependencies.pool(),
					{
						project_id: c.req.valid("query").project_id,
						slug: c.req.valid("param").slug,
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_write",
						),
					},
				);
				c.header("ETag", `\"${value.revision}\"`);
				return c.json(value);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleGetDatasetDraft: async (
			c: Parameters<RouteHandler<typeof getDatasetDraft>>[0],
		) => {
			try {
				const value = await dependencies.getDatasetDraft(dependencies.pool(), {
					project_id: c.req.valid("query").project_id,
					slug: c.req.valid("param").slug,
					authorization: projectAuthorization(trustedTenant(c), "product_read"),
				});
				c.header("ETag", `\"${value.revision}\"`);
				return c.json(value);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handlePutDatasetDraftItem: async (
			c: Parameters<RouteHandler<typeof putDatasetDraftItem>>[0],
		) => {
			try {
				const match = c.req.header("if-match")?.replace(/^"|"$/g, "");
				if (!match || !/^\d+$/.test(match))
					throw new DatasetRepositoryError(
						"BAD_REQUEST",
						"If-Match must contain the current draft revision",
					);
				const body = c.req.valid("json");
				const tenant = trustedTenant(c);
				const authorization = projectAuthorization(tenant, "product_write");
				await dependencies.authorizeDatasetWrite(dependencies.pool(), {
					project_id: c.req.valid("query").project_id,
					authorization,
				});
				if (
					body.source_trace_id &&
					!(await dependencies.targetExists({
						organization_id: tenant.organizationId,
						project_id: c.req.valid("query").project_id,
						trace_id: body.source_trace_id,
						observation_id: body.source_observation_id,
					}))
				)
					throw new DatasetRepositoryError(
						"NOT_FOUND",
						"Source trace not found",
					);
				const item = await dependencies.upsertDatasetDraftItem(
					dependencies.pool(),
					{
						project_id: c.req.valid("query").project_id,
						slug: c.req.valid("param").slug,
						item_key: c.req.valid("param").itemKey,
						revision: Number(match),
						...body,
						authorization,
					},
				);
				c.header("ETag", `\"${Number(match) + 1}\"`);
				return c.json(item);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleDeleteDatasetDraftItem: async (
			c: Parameters<RouteHandler<typeof deleteDatasetDraftItem>>[0],
		) => {
			try {
				const match = c.req.header("if-match")?.replace(/^"|"$/g, "");
				if (!match || !/^\d+$/.test(match))
					throw new DatasetRepositoryError(
						"BAD_REQUEST",
						"If-Match must contain the current draft revision",
					);
				await dependencies.deleteDatasetDraftItem(dependencies.pool(), {
					project_id: c.req.valid("query").project_id,
					slug: c.req.valid("param").slug,
					item_key: c.req.valid("param").itemKey,
					revision: Number(match),
					authorization: projectAuthorization(
						trustedTenant(c),
						"product_write",
					),
				});
				c.header("ETag", `\"${Number(match) + 1}\"`);
				return c.body(null, 204);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleArchiveDataset: async (
			c: Parameters<RouteHandler<typeof archiveDataset>>[0],
		) => {
			try {
				await dependencies.archiveDataset(dependencies.pool(), {
					project_id: c.req.valid("query").project_id,
					slug: c.req.valid("param").slug,
					authorization: projectAuthorization(trustedTenant(c), "destructive"),
				});
				return c.body(null, 204);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleDiscardDatasetDraft: async (
			c: Parameters<RouteHandler<typeof discardDatasetDraft>>[0],
		) => {
			try {
				await dependencies.discardDatasetDraft(dependencies.pool(), {
					project_id: c.req.valid("query").project_id,
					slug: c.req.valid("param").slug,
					authorization: projectAuthorization(
						trustedTenant(c),
						"product_write",
					),
				});
				return c.body(null, 204);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handlePublishDatasetDraft: async (
			c: Parameters<RouteHandler<typeof publishDatasetDraft>>[0],
		) => {
			try {
				const match = c.req.header("if-match")?.replace(/^"|"$/g, "");
				if (!match || !/^\d+$/.test(match))
					throw new DatasetRepositoryError(
						"BAD_REQUEST",
						"If-Match must contain the current draft revision",
					);
				return c.json(
					await dependencies.publishDatasetDraft(dependencies.pool(), {
						project_id: c.req.valid("query").project_id,
						slug: c.req.valid("param").slug,
						revision: Number(match),
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_write",
						),
					}),
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
					await dependencies.createDataset(dependencies.pool(), {
						...c.req.valid("json"),
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_write",
						),
					}),
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
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_read",
						),
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
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_read",
						),
					}),
				);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleAddDatasetItem: async (
			c: Parameters<RouteHandler<typeof addDatasetItem>>[0],
		) =>
			errorResponse(
				c,
				new DatasetRepositoryError(
					"CONFLICT",
					"Legacy dataset item writes are not supported; edit the dataset draft instead",
				),
			),
		handleDeleteDatasetItem: async (
			c: Parameters<RouteHandler<typeof deleteDatasetItem>>[0],
		) =>
			errorResponse(
				c,
				new DatasetRepositoryError(
					"CONFLICT",
					"Legacy dataset item writes are not supported; edit the dataset draft instead",
				),
			),
	};
}

export const {
	handleListDatasets,
	handleCreateDataset,
	handleGetDataset,
	handleListDatasetItems,
	handleAddDatasetItem,
	handleDeleteDatasetItem,
	handleGetDatasetBySlug,
	handlePatchDatasetBySlug,
	handleCreateDatasetDraft,
	handleGetDatasetDraft,
	handlePutDatasetDraftItem,
	handleDeleteDatasetDraftItem,
	handleArchiveDataset,
	handleDiscardDatasetDraft,
	handlePublishDatasetDraft,
} = createDatasetRouteHandlers();
