import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";
import { ProjectIdQuery } from "./prompts.js";

export const DatasetSlug = z
	.string()
	.max(64)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
	.openapi({ example: "support-regression" });

export const Dataset = z
	.object({
		id: z.string().uuid(),
		project_id: z.string().uuid(),
		slug: DatasetSlug,
		name: z.string(),
		description: z.string().nullable(),
		tags: z.array(z.string()),
		latest_published_version: z.number().int().positive().nullable(),
		archived_at: z.string().datetime().nullable(),
		item_count: z.number().int().nonnegative(),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
	})
	.strict()
	.openapi("Dataset");

export const DatasetCreate = z
	.object({
		project_id: z.string().uuid(),
		slug: DatasetSlug.optional(),
		name: z.string().trim().min(1).max(120),
		description: z.string().trim().max(1000).nullable().optional(),
		tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
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
	.superRefine((value, ctx) => {
		if (value.source_observation_id && !value.source_trace_id)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["source_observation_id"],
				message: "Observation provenance requires a trace",
			});
	})
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
export const DatasetSlugParam = z
	.object({
		slug: DatasetSlug.openapi({ param: { name: "slug", in: "path" } }),
	})
	.strict();
export const DatasetMetadataUpdate = z
	.object({
		name: z.string().trim().min(1).max(120).optional(),
		description: z.string().trim().max(1000).nullable().optional(),
		tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
	})
	.strict()
	.refine(
		(value) => Object.keys(value).length > 0,
		"At least one field is required",
	);
export const DatasetDraft = z
	.object({
		id: z.string().uuid(),
		dataset_id: z.string().uuid(),
		project_id: z.string().uuid(),
		base_version: z.number().int().positive().nullable(),
		revision: z.number().int().positive(),
		item_count: z.number().int().nonnegative(),
		created_at: z.string().datetime(),
		updated_at: z.string().datetime(),
	})
	.strict()
	.openapi("DatasetDraft");
export const DatasetDraftItem = z
	.object({
		item_key: z.string().min(1).max(200),
		input: z.record(z.string(), z.unknown()),
		expected_output: z.record(z.string(), z.unknown()).nullable().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
		position: z.number().int().nonnegative().optional(),
	})
	.strict()
	.openapi("DatasetDraftItem");
export const DatasetDraftItemUpsert = DatasetDraftItem.pick({
	input: true,
	expected_output: true,
	metadata: true,
})
	.strict()
	.openapi("DatasetDraftItemUpsert");
export const DatasetDraftItemParam = DatasetSlugParam.extend({
	itemKey: z
		.string()
		.min(1)
		.max(200)
		.openapi({ param: { name: "itemKey", in: "path" } }),
}).strict();
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
