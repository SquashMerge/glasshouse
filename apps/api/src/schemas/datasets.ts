import { z } from "@hono/zod-openapi";
import { DATASET_DRAFT_VALIDATION_VERSION } from "../lib/dataset-draft-validation.js";
import { ErrorEnvelope } from "./common.js";
import { ProjectIdQuery } from "./prompts.js";

export const DatasetSlug = z
	.string()
	.max(64)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
	.openapi({ example: "support-regression" });

const JsonObject = z.record(z.string(), z.unknown());
const MetadataScalar = z.union([
	z.string().max(512),
	z.number().finite(),
	z.boolean(),
	z.null(),
]);
const DatasetDraftMetadata = z
	.record(
		z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
		MetadataScalar.or(z.array(MetadataScalar).max(16)),
	)
	.refine((value) => Object.keys(value).length <= 32, {
		message: "Metadata must not contain more than 32 fields",
	});
const DatasetDraftItemState = z.enum(["draft", "reviewed"]);
const DatasetCaptureContext = z
	.object({
		kind: z.enum(["trace", "observation", "feedback"]).optional(),
		redaction_applied: z.boolean().optional(),
	})
	.strict();
const DatasetExternalId = z.string().trim().min(1).max(200);
const DatasetDraftItemKey = z.string().trim().min(1).max(200);

export const Dataset = z
	.object({
		id: z.string().uuid(),
		project_id: z.string().uuid(),
		slug: DatasetSlug,
		name: z.string(),
		description: z.string().nullable(),
		tags: z.array(z.string()),
		revision: z.number().int().positive(),
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
		item_key: z.string().nullable().default(null),
		validation_version: z.number().int().positive(),
		state: DatasetDraftItemState,
		input: JsonObject,
		expected_output: JsonObject.nullable(),
		metadata: DatasetDraftMetadata,
		external_id: DatasetExternalId.nullable(),
		source_trace_id: z.string().nullable(),
		source_observation_id: z.string().nullable(),
		source_feedback_id: z.string().uuid().nullable(),
		capture_context: DatasetCaptureContext,
		created_by: z.string().uuid().nullable(),
		updated_by: z.string().uuid().nullable(),
		reviewed_by: z.string().uuid().nullable(),
		reviewed_at: z.string().datetime().nullable(),
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("DatasetItem");

export const DatasetItemCreate = z
	.object({
		project_id: z.string().uuid(),
		input: JsonObject,
		expected_output: JsonObject.nullable().optional(),
		metadata: DatasetDraftMetadata.optional(),
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
export const DatasetListQuery = DatasetProjectQuery.extend({
	include_archived: z.coerce.boolean().optional(),
})
	.strict()
	.openapi("DatasetListQuery");
export const DatasetExportQuery = DatasetProjectQuery.extend({
	format: z.enum(["csv", "jsonl"]),
	representation: z.enum(["draft", "version"]),
	version: z.coerce.number().int().positive().optional(),
})
	.strict()
	.superRefine((value, ctx) => {
		if (value.representation === "version" && value.version === undefined)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["version"],
				message: "An immutable version export requires version",
			});
		if (value.representation === "draft" && value.version !== undefined)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["version"],
				message: "Draft exports do not accept version",
			});
	})
	.openapi("DatasetExportQuery");
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
export const DatasetTombstone = z
	.object({ confirmation_slug: DatasetSlug })
	.strict()
	.openapi("DatasetTombstone");
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
		id: z.string().uuid(),
		item_key: z.string().min(1).max(200),
		validation_version: z.number().int().positive(),
		state: DatasetDraftItemState,
		input: JsonObject,
		expected_output: JsonObject.nullable(),
		metadata: DatasetDraftMetadata,
		external_id: DatasetExternalId.nullable(),
		source_trace_id: z.string().max(128).nullable(),
		source_observation_id: z.string().max(128).nullable(),
		source_feedback_id: z.string().uuid().nullable(),
		capture_context: DatasetCaptureContext,
		created_by: z.string().uuid().nullable(),
		updated_by: z.string().uuid().nullable(),
		reviewed_by: z.string().uuid().nullable(),
		reviewed_at: z.string().datetime().nullable(),
		position: z.number().int().nonnegative(),
	})
	.strict()
	.openapi("DatasetDraftItem");

const DatasetDraftItemPayload = z
	.object({
		input: JsonObject,
		expected_output: JsonObject.nullable().optional(),
		metadata: DatasetDraftMetadata.optional(),
		external_id: DatasetExternalId.nullable().optional(),
		source_trace_id: z.string().min(1).max(128).nullable().optional(),
		source_observation_id: z.string().min(1).max(128).nullable().optional(),
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
	.openapi("DatasetDraftItemPayload");
export const DatasetDraftItemUpsert = DatasetDraftItemPayload.openapi(
	"DatasetDraftItemUpsert",
);
export const DatasetDraftImport = z
	.object({
		items: z
			.array(
				DatasetDraftItemPayload.extend({
					item_key: DatasetDraftItemKey,
				}).strict(),
			)
			.min(1)
			.max(500),
	})
	.strict()
	.openapi("DatasetDraftImport");
export const DatasetDraftCapture = z
	.object({
		item_key: DatasetDraftItemKey.optional(),
		external_id: DatasetExternalId.nullable().optional(),
		source_trace_id: z.string().regex(/^[0-9a-f]{32}$/),
		source_observation_id: z.string().min(1).max(128).optional(),
	})
	.strict()
	.openapi("DatasetDraftCapture");
export const DatasetDraftOrder = z
	.object({ item_ids: z.array(z.string().uuid()).min(1).max(500) })
	.strict()
	.superRefine((value, ctx) => {
		if (new Set(value.item_ids).size !== value.item_ids.length)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["item_ids"],
				message: "Each draft item may appear only once",
			});
	})
	.openapi("DatasetDraftOrder");
export const DatasetDraftItemRevision = DatasetDraftItem.extend({
	item_revision: z.number().int().positive(),
	action: z.enum(["upserted", "captured", "imported", "reviewed", "reordered"]),
	actor_id: z.string().uuid(),
	created_at: z.string().datetime(),
}).openapi("DatasetDraftItemRevision");
export const DatasetDraftItemRevisionList = z
	.object({ items: z.array(DatasetDraftItemRevision) })
	.strict()
	.openapi("DatasetDraftItemRevisionList");
export const DatasetDraftValidationIssue = z
	.object({
		item_id: z.string().uuid().nullable(),
		item_key: z.string().nullable(),
		field: z.string(),
		code: z.string(),
		message: z.string(),
	})
	.strict()
	.openapi("DatasetDraftValidationIssue");
export const DatasetDraftValidation = z
	.object({
		validation_version: z.number().int().positive(),
		valid: z.boolean(),
		errors: z.array(DatasetDraftValidationIssue),
	})
	.strict()
	.openapi("DatasetDraftValidation");
export const DatasetDraftMutation = z
	.object({
		validation_version: z.literal(DATASET_DRAFT_VALIDATION_VERSION),
		revision: z.number().int().positive(),
		idempotent: z.boolean(),
	})
	.strict()
	.openapi("DatasetDraftMutation");
export const DatasetDraftImportResult = DatasetDraftMutation.extend({
	items: z.array(DatasetDraftItem),
}).openapi("DatasetDraftImportResult");
export const DatasetDraftCaptureResult = DatasetDraftMutation.extend({
	item: DatasetDraftItem.nullable(),
}).openapi("DatasetDraftCaptureResult");
export const DatasetDraftItemParam = DatasetSlugParam.extend({
	itemId: z
		.string()
		.uuid()
		.openapi({ param: { name: "itemId", in: "path" } }),
}).strict();
export const DatasetDraftItemKeyParam = DatasetSlugParam.extend({
	itemKey: DatasetDraftItemKey.openapi({
		param: { name: "itemKey", in: "path" },
	}),
}).strict();
export const DatasetDraftItemRevisionParam = DatasetDraftItemParam;
export const DatasetDraftPublish = z
	.object({
		version: z.number().int().positive(),
		item_count: z.number().int().nonnegative(),
	})
	.strict()
	.openapi("DatasetDraftPublish");
export const DatasetVersionSummary = z
	.object({
		id: z.string().uuid(),
		dataset_id: z.string().uuid(),
		project_id: z.string().uuid(),
		version: z.number().int().positive(),
		item_count: z.number().int().nonnegative(),
		content_hash: z.string().regex(/^[0-9a-f]{64}$/),
		validation_version: z.number().int().positive(),
		published_by: z.string().uuid().nullable(),
		published_draft_revision: z.number().int().positive().nullable(),
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("DatasetVersionSummary");
export const DatasetVersion = DatasetVersionSummary.extend({
	items: z.array(
		z
			.object({
				id: z.string().uuid(),
				item_key: DatasetDraftItemKey,
				position: z.number().int().nonnegative(),
				validation_version: z.number().int().positive(),
				state: DatasetDraftItemState,
				input: JsonObject,
				expected_output: JsonObject.nullable(),
				metadata: DatasetDraftMetadata,
				external_id: DatasetExternalId.nullable(),
				source_trace_id: z.string().nullable(),
				source_observation_id: z.string().nullable(),
				feedback_score_id: z.string().uuid().nullable(),
				capture_context: DatasetCaptureContext,
				curated_by: z.string().uuid().nullable(),
				reviewed_by: z.string().uuid().nullable(),
				reviewed_at: z.string().datetime().nullable(),
				created_at: z.string().datetime(),
			})
			.strict(),
	),
})
	.strict()
	.openapi("DatasetVersion");
export const DatasetVersionList = z
	.object({ items: z.array(DatasetVersionSummary) })
	.strict()
	.openapi("DatasetVersionList");
export const DatasetVersionParam = DatasetSlugParam.extend({
	version: z.coerce
		.number()
		.int()
		.positive()
		.openapi({
			param: { name: "version", in: "path" },
		}),
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
