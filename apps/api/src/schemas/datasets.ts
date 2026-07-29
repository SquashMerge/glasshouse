import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";
import { ProjectIdQuery } from "./prompts.js";

export const Dataset = z
	.object({
		id: z.string().uuid(),
		project_id: z.string().uuid(),
		name: z.string(),
		description: z.string().nullable(),
		item_count: z.number().int().nonnegative(),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
	})
	.strict()
	.openapi("Dataset");

export const DatasetCreate = z
	.object({
		project_id: z.string().uuid(),
		name: z.string().trim().min(1).max(120),
		description: z.string().trim().max(1000).nullable().optional(),
	})
	.strict()
	.openapi("DatasetCreate");

export const DatasetIdParam = z
	.object({
		id: z
			.string()
			.uuid()
			.openapi({ param: { name: "id", in: "path" } }),
	})
	.strict();

export const DatasetItem = z
	.object({
		id: z.string().uuid(),
		dataset_id: z.string().uuid(),
		input: z.record(z.string(), z.unknown()),
		expected_output: z.record(z.string(), z.unknown()).nullable(),
		metadata: z.record(z.string(), z.unknown()),
		source_trace_id: z.string().nullable(),
		source_observation_id: z.string().nullable(),
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("DatasetItem");

export const DatasetItemCreate = z
	.object({
		project_id: z.string().uuid(),
		input: z.record(z.string(), z.unknown()),
		expected_output: z.record(z.string(), z.unknown()).nullable().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
		source_trace_id: z.string().max(128).nullable().optional(),
		source_observation_id: z.string().max(128).nullable().optional(),
	})
	.strict()
	.openapi("DatasetItemCreate");

export const DatasetItemIdParams = z
	.object({
		id: z
			.string()
			.uuid()
			.openapi({ param: { name: "id", in: "path" } }),
		itemId: z
			.string()
			.uuid()
			.openapi({ param: { name: "itemId", in: "path" } }),
	})
	.strict();

export const DatasetProjectQuery = ProjectIdQuery;
export const DatasetErrorResponses = {
	400: {
		description: "Bad request",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description: "Dataset not found",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	409: {
		description: "Dataset already exists",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal server error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
