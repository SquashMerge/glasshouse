// schemas/traces.ts
import { z } from "@hono/zod-openapi";
import { ErrorEnvelope, NotImplementedError, PageQuery } from "./common.js";

const TraceCursorQuery = z
	.string()
	.min(1)
	.max(2048)
	.regex(/^[A-Za-z0-9_-]+$/)
	.optional()
	.openapi({
		param: {
			name: "cursor",
			in: "query",
			description: "Opaque, project-scoped keyset cursor from next_cursor.",
		},
	});

const UnsupportedOffsetQuery = z
	.string()
	.optional()
	.refine((value) => value === undefined, "Offset pagination is not supported")
	.openapi({
		param: {
			name: "offset",
			in: "query",
			deprecated: true,
			description:
				"Unsupported; use the opaque cursor returned by next_cursor.",
		},
	});

export const TraceStatus = z.enum(["ok", "error"]).openapi("TraceStatus");

export const Trace = z
	.object({
		trace_id: z.string(),
		project_id: z.string(),
		name: z.string(),
		start_time: z.string().datetime(),
		end_time: z.string().datetime().nullable().optional(),
		duration_ms: z.number().int().nullable().optional(),
		status: TraceStatus,
		user_id: z.string().default(""),
		session_id: z.string().default(""),
		agent_id: z.string().default(""),
		agent_version: z.string().default(""),
		env: z.string(),
		tags: z.array(z.string()).default([]),
		input_text: z.string().default(""),
		output_text: z.string().default(""),
		input_retained_truncated: z.boolean().optional(),
		output_retained_truncated: z.boolean().optional(),
		input_excerpt_truncated: z.boolean().optional(),
		output_excerpt_truncated: z.boolean().optional(),
	})
	.openapi("Trace");

export const TraceList = z
	.object({
		items: z.array(Trace),
		total: z.number().int(),
		response_truncated: z.boolean().optional(),
		next_cursor: z.string().optional(),
	})
	.openapi("TraceList");

const ProjectIdQuery = z
	.string()
	.uuid()
	.openapi({ param: { name: "project_id", in: "query" } });

export const TraceDetailQuery = z
	.object({
		expand: z.string().optional(),
		project_id: ProjectIdQuery,
		cursor: TraceCursorQuery,
	})
	.strict();

export const TraceEventsQuery = z
	.object({ project_id: ProjectIdQuery })
	.strict();
export const TraceListQuery = PageQuery.omit({ offset: true })
	.extend({
		project_id: ProjectIdQuery,
		cursor: TraceCursorQuery,
		offset: UnsupportedOffsetQuery,
	})
	.passthrough();

export const PromptProvenance = z
	.object({
		id: z
			.string()
			.max(64)
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
		version: z.number().int().positive().refine(Number.isSafeInteger),
		content_hash: z.string().regex(/^[0-9a-f]{64}$/),
	})
	.strict()
	.openapi("PromptProvenance");

export const ObservationMetadata = z
	.object({
		schema_version: z.literal(1),
		attributes: z.array(
			z.object({
				key: z.string(),
				value: z
					.union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
					.optional(),
			}),
		),
		prompt_provenance: PromptProvenance.nullable(),
		truncated: z.boolean().optional(),
	})
	.strict()
	.openapi("ObservationMetadata");

export const Observation = z
	.object({
		observation_id: z.string(),
		trace_id: z.string(),
		project_id: z.string(),
		parent_observation_id: z.string().nullable().optional(),
		type: z.enum(["span", "event", "generation", "tool"]),
		name: z.string(),
		start_time: z.string().datetime(),
		end_time: z.string().datetime().nullable().optional(),
		duration_ms: z.number().int().nullable().optional(),
		status: TraceStatus,
		model: z.string().nullable().optional(),
		input_text: z.string().default(""),
		output_text: z.string().default(""),
		input_retained_truncated: z.boolean().optional(),
		output_retained_truncated: z.boolean().optional(),
		input_excerpt_truncated: z.boolean().optional(),
		output_excerpt_truncated: z.boolean().optional(),
		metadata_truncated: z.boolean().optional(),
		metadata: ObservationMetadata,
	})
	.openapi("Observation");

export const ObservationList = z
	.object({
		items: z.array(Observation),
		total: z.number().int(),
		response_truncated: z.boolean().optional(),
		next_cursor: z.string().optional(),
	})
	.openapi("ObservationList");

export const TraceStubResponses = {
	501: {
		description: "Not implemented",
		content: { "application/json": { schema: NotImplementedError } },
	},
	404: {
		description: "Trace not found",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
