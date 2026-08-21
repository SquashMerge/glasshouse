import { createRoute, type RouteHandler, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ch } from "../db/clickhouse.js";
import {
	addDatasetItem as addDatasetItemRecord,
	archiveDataset as archiveDatasetRecord,
	authorizeDatasetWrite as authorizeDatasetWriteRecord,
	captureDatasetDraftItem as captureDatasetDraftItemRecord,
	createDataset as createDatasetRecord,
	DatasetRepositoryError,
	datasetCurationRequestHash,
	deleteDatasetDraftItem as deleteDatasetDraftItemRecord,
	deleteDatasetItem as deleteDatasetItemRecord,
	discardDatasetDraft as discardDatasetDraftRecord,
	getDatasetBySlug as getDatasetBySlugRecord,
	getDatasetDraftItemRevisions as getDatasetDraftItemRevisionsRecord,
	getDatasetDraft as getDatasetDraftRecord,
	getDataset as getDatasetRecord,
	getOrCreateDatasetDraft as getOrCreateDatasetDraftRecord,
	importDatasetDraftItems as importDatasetDraftItemsRecord,
	listDatasetItems as listDatasetItemsRecord,
	listDatasets as listDatasetsRecord,
	listPublishedDatasetItems as listPublishedDatasetItemsRecord,
	publishDatasetDraft as publishDatasetDraftRecord,
	reorderDatasetDraftItems as reorderDatasetDraftItemsRecord,
	reviewDatasetDraftItem as reviewDatasetDraftItemRecord,
	updateDatasetMetadata as updateDatasetMetadataRecord,
	upsertDatasetDraftItem as upsertDatasetDraftItemRecord,
	validateDatasetDraft as validateDatasetDraftRecord,
} from "../db/datasets.js";
import { pgPool } from "../db/postgres.js";
import { projectAuthorization } from "../db/project-authorization.js";
import {
	captureTextAsObject,
	DATASET_DRAFT_VALIDATION_VERSION,
} from "../lib/dataset-draft-validation.js";
import { logger } from "../lib/logger.js";
import {
	Dataset,
	DatasetCreate,
	DatasetDraft,
	DatasetDraftCapture,
	DatasetDraftCaptureResult,
	DatasetDraftImport,
	DatasetDraftImportResult,
	DatasetDraftItem,
	DatasetDraftItemKeyParam,
	DatasetDraftItemParam,
	DatasetDraftItemRevisionList,
	DatasetDraftItemUpsert,
	DatasetDraftMutation,
	DatasetDraftOrder,
	DatasetDraftPublish,
	DatasetDraftValidation,
	DatasetErrorResponses,
	DatasetIdParam,
	DatasetItem,
	DatasetItemCreate,
	DatasetItemIdParams,
	DatasetMetadataUpdate,
	DatasetProjectQuery,
	DatasetSlugParam,
} from "../schemas/datasets.js";
import { trustedTenant } from "../tenancy.js";

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
const OptionalIfMatchDraftRevision = z.object({
	"if-match": DraftRevisionEtag.optional().openapi({
		param: {
			name: "if-match",
			in: "header",
			required: false,
			description:
				"Quoted current draft revision. Omit only to create a draft after request validation when none exists.",
		},
	}),
});
const DatasetIdempotencyHeader = z.object({
	"idempotency-key": z
		.string()
		.regex(/^[ -~]{1,200}$/)
		.openapi({
			param: {
				name: "idempotency-key",
				in: "header",
				required: true,
				description: "Stable key used to replay a curation request safely.",
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
			...(error.code === "INTERNAL" || !error.details
				? {}
				: { details: error.details }),
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
export const listPublishedDatasetItems = createRoute({
	method: "get",
	path: "/v1/datasets/{id}/published-items",
	tags: [tag],
	summary: "List the latest published dataset items",
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
export const validateDatasetDraft = createRoute({
	method: "post",
	path: "/v1/datasets/by-slug/{slug}/draft/validate",
	tags: [tag],
	summary: "Validate every draft item with the current versioned contract",
	security: [{ basicAuth: [] }],
	request: { params: DatasetSlugParam, query: DatasetProjectQuery },
	responses: {
		200: {
			description: "Validation result",
			content: { "application/json": { schema: DatasetDraftValidation } },
		},
		...DatasetErrorResponses,
	},
});
export const importDatasetDraftItems = createRoute({
	method: "post",
	path: "/v1/datasets/by-slug/{slug}/draft/import",
	tags: [tag],
	summary: "Import up to 500 draft items atomically",
	security: [{ basicAuth: [] }],
	request: {
		params: DatasetSlugParam,
		query: DatasetProjectQuery,
		headers: OptionalIfMatchDraftRevision.merge(DatasetIdempotencyHeader),
		body: { content: { "application/json": { schema: DatasetDraftImport } } },
	},
	responses: {
		200: {
			description: "Imported draft items",
			headers: DraftRevisionHeaders,
			content: { "application/json": { schema: DatasetDraftImportResult } },
		},
		...DatasetErrorResponses,
	},
});
export const captureDatasetDraftItem = createRoute({
	method: "post",
	path: "/v1/datasets/by-slug/{slug}/draft/capture",
	tags: [tag],
	summary: "Capture redacted trace or observation evidence into a draft",
	security: [{ basicAuth: [] }],
	request: {
		params: DatasetSlugParam,
		query: DatasetProjectQuery,
		headers: OptionalIfMatchDraftRevision.merge(DatasetIdempotencyHeader),
		body: { content: { "application/json": { schema: DatasetDraftCapture } } },
	},
	responses: {
		200: {
			description: "Captured draft item",
			headers: DraftRevisionHeaders,
			content: { "application/json": { schema: DatasetDraftCaptureResult } },
		},
		...DatasetErrorResponses,
	},
});
export const reorderDatasetDraftItems = createRoute({
	method: "put",
	path: "/v1/datasets/by-slug/{slug}/draft/items/order",
	tags: [tag],
	summary: "Reorder every draft item deterministically",
	security: [{ basicAuth: [] }],
	request: {
		params: DatasetSlugParam,
		query: DatasetProjectQuery,
		headers: IfMatchDraftRevision,
		body: { content: { "application/json": { schema: DatasetDraftOrder } } },
	},
	responses: {
		200: {
			description: "Draft reordered",
			headers: DraftRevisionHeaders,
			content: { "application/json": { schema: DatasetDraftMutation } },
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
		params: DatasetDraftItemKeyParam,
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
export const reviewDatasetDraftItem = createRoute({
	method: "post",
	path: "/v1/datasets/by-slug/{slug}/draft/items/{itemId}/review",
	tags: [tag],
	summary: "Mark a draft item as reviewed",
	security: [{ basicAuth: [] }],
	request: {
		params: DatasetDraftItemParam,
		query: DatasetProjectQuery,
		headers: IfMatchDraftRevision,
	},
	responses: {
		200: {
			description: "Reviewed draft item",
			headers: DraftRevisionHeaders,
			content: { "application/json": { schema: DatasetDraftItem } },
		},
		...DatasetErrorResponses,
	},
});
export const listDatasetDraftItemRevisions = createRoute({
	method: "get",
	path: "/v1/datasets/by-slug/{slug}/draft/items/{itemId}/revisions",
	tags: [tag],
	summary: "List a draft item's redacted revision history",
	security: [{ basicAuth: [] }],
	request: {
		params: DatasetDraftItemParam,
		query: DatasetProjectQuery,
	},
	responses: {
		200: {
			description: "Draft item revisions",
			content: { "application/json": { schema: DatasetDraftItemRevisionList } },
		},
		...DatasetErrorResponses,
	},
});
export const deleteDatasetDraftItem = createRoute({
	method: "delete",
	path: "/v1/datasets/by-slug/{slug}/draft/items/{itemId}",
	tags: [tag],
	summary: "Delete a draft item using its UUID identity",
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
			headers: DraftRevisionHeaders,
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
	listPublishedDatasetItems: typeof listPublishedDatasetItemsRecord;
	addDatasetItem: typeof addDatasetItemRecord;
	deleteDatasetItem: typeof deleteDatasetItemRecord;
	getDatasetBySlug: typeof getDatasetBySlugRecord;
	updateDatasetMetadata: typeof updateDatasetMetadataRecord;
	getOrCreateDatasetDraft: typeof getOrCreateDatasetDraftRecord;
	getDatasetDraft: typeof getDatasetDraftRecord;
	upsertDatasetDraftItem: typeof upsertDatasetDraftItemRecord;
	validateDatasetDraft: typeof validateDatasetDraftRecord;
	importDatasetDraftItems: typeof importDatasetDraftItemsRecord;
	captureDatasetDraftItem: typeof captureDatasetDraftItemRecord;
	reorderDatasetDraftItems: typeof reorderDatasetDraftItemsRecord;
	reviewDatasetDraftItem: typeof reviewDatasetDraftItemRecord;
	getDatasetDraftItemRevisions: typeof getDatasetDraftItemRevisionsRecord;
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
	captureSource: (input: {
		organization_id: string;
		project_id: string;
		trace_id: string;
		observation_id?: string | null;
	}) => Promise<{ input_text: string; output_text: string } | null>;
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
const production: DatasetRouteDependencies = {
	pool: pgPool,
	listDatasets: listDatasetsRecord,
	createDataset: createDatasetRecord,
	getDataset: getDatasetRecord,
	listDatasetItems: listDatasetItemsRecord,
	listPublishedDatasetItems: listPublishedDatasetItemsRecord,
	addDatasetItem: addDatasetItemRecord,
	deleteDatasetItem: deleteDatasetItemRecord,
	getDatasetBySlug: getDatasetBySlugRecord,
	updateDatasetMetadata: updateDatasetMetadataRecord,
	getOrCreateDatasetDraft: getOrCreateDatasetDraftRecord,
	getDatasetDraft: getDatasetDraftRecord,
	upsertDatasetDraftItem: upsertDatasetDraftItemRecord,
	validateDatasetDraft: validateDatasetDraftRecord,
	importDatasetDraftItems: importDatasetDraftItemsRecord,
	captureDatasetDraftItem: captureDatasetDraftItemRecord,
	reorderDatasetDraftItems: reorderDatasetDraftItemsRecord,
	reviewDatasetDraftItem: reviewDatasetDraftItemRecord,
	getDatasetDraftItemRevisions: getDatasetDraftItemRevisionsRecord,
	deleteDatasetDraftItem: deleteDatasetDraftItemRecord,
	authorizeDatasetWrite: authorizeDatasetWriteRecord,
	archiveDataset: archiveDatasetRecord,
	discardDatasetDraft: discardDatasetDraftRecord,
	publishDatasetDraft: publishDatasetDraftRecord,
	targetExists,
	captureSource,
};

export function createDatasetRouteHandlers(
	dependencies: DatasetRouteDependencies = production,
) {
	async function sourceCapturedItem<
		T extends {
			input: Record<string, unknown>;
			expected_output?: Record<string, unknown> | null;
			source_trace_id?: string | null;
			source_observation_id?: string | null;
		},
	>(
		item: T,
		organization_id: string,
		project_id: string,
	): Promise<
		T & {
			capture?: boolean;
			capture_context?: { kind: "trace" | "observation" };
		}
	> {
		if (!item.source_trace_id) return item;
		const source = await dependencies.captureSource({
			organization_id,
			project_id,
			trace_id: item.source_trace_id,
			observation_id: item.source_observation_id,
		});
		if (!source)
			throw new DatasetRepositoryError("NOT_FOUND", "Source trace not found");
		return {
			...item,
			input: captureTextAsObject(source.input_text),
			expected_output: source.output_text
				? captureTextAsObject(source.output_text)
				: null,
			capture: true,
			capture_context: {
				kind: item.source_observation_id ? "observation" : "trace",
			},
		};
	}

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
		handleValidateDatasetDraft: async (
			c: Parameters<RouteHandler<typeof validateDatasetDraft>>[0],
		) => {
			try {
				return c.json(
					await dependencies.validateDatasetDraft(dependencies.pool(), {
						project_id: c.req.valid("query").project_id,
						slug: c.req.valid("param").slug,
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
		handleImportDatasetDraftItems: async (
			c: Parameters<RouteHandler<typeof importDatasetDraftItems>>[0],
		) => {
			try {
				const match = c.req.header("if-match")?.replace(/^"|"$/g, "");
				if (match !== undefined && !/^\d+$/.test(match))
					throw new DatasetRepositoryError(
						"BAD_REQUEST",
						"If-Match must contain a draft revision",
					);
				const project_id = c.req.valid("query").project_id;
				const tenant = trustedTenant(c);
				const authorization = projectAuthorization(tenant, "product_write");
				await dependencies.authorizeDatasetWrite(dependencies.pool(), {
					project_id,
					authorization,
				});
				const idempotency_items = c.req.valid("json").items.map((item) => ({
					...item,
					project_id,
				}));
				const result = await dependencies.importDatasetDraftItems(
					dependencies.pool(),
					{
						project_id,
						slug: c.req.valid("param").slug,
						revision: match === undefined ? undefined : Number(match),
						items: await Promise.all(
							idempotency_items.map((item) =>
								sourceCapturedItem(item, tenant.organizationId, project_id),
							),
						),
						idempotency_items,
						idempotency_key: c.req.valid("header")["idempotency-key"],
						authorization,
					},
				);
				c.header("ETag", `\"${result.revision}\"`);
				return c.json({
					items: result.items,
					revision: result.revision,
					idempotent: result.idempotent,
					validation_version: DATASET_DRAFT_VALIDATION_VERSION,
				});
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleCaptureDatasetDraftItem: async (
			c: Parameters<RouteHandler<typeof captureDatasetDraftItem>>[0],
		) => {
			try {
				const match = c.req.header("if-match")?.replace(/^"|"$/g, "");
				if (match !== undefined && !/^\d+$/.test(match))
					throw new DatasetRepositoryError(
						"BAD_REQUEST",
						"If-Match must contain a draft revision",
					);
				const body = c.req.valid("json");
				const tenant = trustedTenant(c);
				const project_id = c.req.valid("query").project_id;
				const authorization = projectAuthorization(tenant, "product_write");
				await dependencies.authorizeDatasetWrite(dependencies.pool(), {
					project_id,
					authorization,
				});
				const source = await dependencies.captureSource({
					organization_id: tenant.organizationId,
					project_id,
					trace_id: body.source_trace_id,
					observation_id: body.source_observation_id,
				});
				if (!source)
					throw new DatasetRepositoryError(
						"NOT_FOUND",
						"Source trace not found",
					);
				const result = await dependencies.captureDatasetDraftItem(
					dependencies.pool(),
					{
						project_id,
						slug: c.req.valid("param").slug,
						revision: match === undefined ? undefined : Number(match),
						item_key:
							body.item_key ??
							`capture-${datasetCurationRequestHash(c.req.valid("header")["idempotency-key"]).slice(0, 32)}`,
						input: captureTextAsObject(source.input_text),
						expected_output: source.output_text
							? captureTextAsObject(source.output_text)
							: null,
						metadata: {},
						external_id: body.external_id ?? null,
						source_trace_id: body.source_trace_id,
						source_observation_id: body.source_observation_id ?? null,
						capture_context: {
							kind: body.source_observation_id ? "observation" : "trace",
						},
						idempotency_key: c.req.valid("header")["idempotency-key"],
						authorization,
					},
				);
				c.header("ETag", `\"${result.revision}\"`);
				return c.json({
					item: result.item,
					revision: result.revision,
					idempotent: result.idempotent,
					validation_version: DATASET_DRAFT_VALIDATION_VERSION,
				});
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleReorderDatasetDraftItems: async (
			c: Parameters<RouteHandler<typeof reorderDatasetDraftItems>>[0],
		) => {
			try {
				const match = c.req.header("if-match")?.replace(/^"|"$/g, "");
				if (!match || !/^\d+$/.test(match))
					throw new DatasetRepositoryError(
						"BAD_REQUEST",
						"If-Match must contain the current draft revision",
					);
				const result = await dependencies.reorderDatasetDraftItems(
					dependencies.pool(),
					{
						project_id: c.req.valid("query").project_id,
						slug: c.req.valid("param").slug,
						item_ids: c.req.valid("json").item_ids,
						revision: Number(match),
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_write",
						),
					},
				);
				c.header("ETag", `\"${result.revision}\"`);
				return c.json({
					...result,
					validation_version: DATASET_DRAFT_VALIDATION_VERSION,
					idempotent: false,
				});
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
				const project_id = c.req.valid("query").project_id;
				await dependencies.authorizeDatasetWrite(dependencies.pool(), {
					project_id,
					authorization,
				});
				const capturedItem = await sourceCapturedItem(
					body,
					tenant.organizationId,
					project_id,
				);
				const item = await dependencies.upsertDatasetDraftItem(
					dependencies.pool(),
					{
						project_id,
						slug: c.req.valid("param").slug,
						item_key: c.req.valid("param").itemKey,
						revision: Number(match),
						...capturedItem,
						authorization,
					},
				);
				c.header("ETag", `\"${Number(match) + 1}\"`);
				return c.json(item);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleReviewDatasetDraftItem: async (
			c: Parameters<RouteHandler<typeof reviewDatasetDraftItem>>[0],
		) => {
			try {
				const match = c.req.header("if-match")?.replace(/^"|"$/g, "");
				if (!match || !/^\d+$/.test(match))
					throw new DatasetRepositoryError(
						"BAD_REQUEST",
						"If-Match must contain the current draft revision",
					);
				const result = await dependencies.reviewDatasetDraftItem(
					dependencies.pool(),
					{
						project_id: c.req.valid("query").project_id,
						slug: c.req.valid("param").slug,
						item_id: c.req.valid("param").itemId,
						revision: Number(match),
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_write",
						),
					},
				);
				c.header("ETag", `\"${result.revision}\"`);
				return c.json(result.item);
			} catch (cause) {
				return errorResponse(c, cause);
			}
		},
		handleListDatasetDraftItemRevisions: async (
			c: Parameters<RouteHandler<typeof listDatasetDraftItemRevisions>>[0],
		) => {
			try {
				return c.json(
					await dependencies.getDatasetDraftItemRevisions(dependencies.pool(), {
						project_id: c.req.valid("query").project_id,
						slug: c.req.valid("param").slug,
						item_id: c.req.valid("param").itemId,
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
					item_key: c.req.valid("param").itemId,
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
				const published = await dependencies.publishDatasetDraft(
					dependencies.pool(),
					{
						project_id: c.req.valid("query").project_id,
						slug: c.req.valid("param").slug,
						revision: Number(match),
						authorization: projectAuthorization(
							trustedTenant(c),
							"product_write",
						),
					},
				);
				c.header("ETag", `\"${published.version}\"`);
				return c.json(published);
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
		handleListPublishedDatasetItems: async (
			c: Parameters<RouteHandler<typeof listPublishedDatasetItems>>[0],
		) => {
			try {
				return c.json(
					await dependencies.listPublishedDatasetItems(dependencies.pool(), {
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
	handleListPublishedDatasetItems,
	handleAddDatasetItem,
	handleDeleteDatasetItem,
	handleGetDatasetBySlug,
	handlePatchDatasetBySlug,
	handleCreateDatasetDraft,
	handleGetDatasetDraft,
	handleValidateDatasetDraft,
	handleImportDatasetDraftItems,
	handleCaptureDatasetDraftItem,
	handleReorderDatasetDraftItems,
	handlePutDatasetDraftItem,
	handleReviewDatasetDraftItem,
	handleListDatasetDraftItemRevisions,
	handleDeleteDatasetDraftItem,
	handleArchiveDataset,
	handleDiscardDatasetDraft,
	handlePublishDatasetDraft,
} = createDatasetRouteHandlers();
