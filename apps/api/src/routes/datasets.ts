import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import {
	Dataset,
	DatasetCreate,
	DatasetItem,
	DatasetItemCreate,
	DatasetStubResponses,
} from "../schemas/datasets.js";
import { IdParam } from "../schemas/common.js";
import { notImplemented } from "./_stub.js";

const tag = "datasets";

export const listDatasets = createRoute({
	method: "get",
	path: "/v1/datasets",
	tags: [tag],
	summary: "List datasets",
	responses: {
		200: {
			description: "OK",
			content: {
				"application/json": {
					schema: z.object({
						items: z.array(Dataset),
						total: z.number().int(),
					}),
				},
			},
		},
		...DatasetStubResponses,
	},
});
export const handleListDatasets = () => notImplemented();

export const createDataset = createRoute({
	method: "post",
	path: "/v1/datasets",
	tags: [tag],
	summary: "Create a dataset",
	request: {
		body: { content: { "application/json": { schema: DatasetCreate } } },
	},
	responses: {
		201: {
			description: "Dataset created",
			content: { "application/json": { schema: Dataset } },
		},
		...DatasetStubResponses,
	},
});
export const handleCreateDataset = () => notImplemented();

export const getDataset = createRoute({
	method: "get",
	path: "/v1/datasets/{id}",
	tags: [tag],
	summary: "Get a dataset",
	request: { params: IdParam },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Dataset } },
		},
		...DatasetStubResponses,
	},
});
export const handleGetDataset = (_id: string) => notImplemented();

export const listDatasetItems = createRoute({
	method: "get",
	path: "/v1/datasets/{id}/items",
	tags: [tag],
	summary: "List dataset items",
	request: { params: IdParam },
	responses: {
		200: {
			description: "OK",
			content: {
				"application/json": {
					schema: z.object({ items: z.array(DatasetItem) }),
				},
			},
		},
		...DatasetStubResponses,
	},
});
export const handleListDatasetItems = (_id: string) => notImplemented();

export const addDatasetItem = createRoute({
	method: "post",
	path: "/v1/datasets/{id}/items",
	tags: [tag],
	summary: "Add a dataset item",
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: DatasetItemCreate } } },
	},
	responses: {
		201: {
			description: "Item added",
			content: { "application/json": { schema: DatasetItem } },
		},
		...DatasetStubResponses,
	},
});
export const handleAddDatasetItem = (_id: string) => notImplemented();

export const deleteDatasetItem = createRoute({
	method: "delete",
	path: "/v1/datasets/{id}/items/{itemId}",
	tags: [tag],
	summary: "Delete a dataset item",
	request: {
		params: z.object({
			id: IdParam.shape.id,
			itemId: z
				.string()
				.uuid()
				.openapi({ param: { name: "itemId", in: "path" } }),
		}),
	},
	responses: { 204: { description: "No content" }, ...DatasetStubResponses },
});
export const handleDeleteDatasetItem = (_id: string, _itemId: string) =>
	notImplemented();
