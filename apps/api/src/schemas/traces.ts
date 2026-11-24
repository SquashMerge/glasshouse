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
			description:
				"Opaque, project-scoped keyset cursor from next_cursor. Do not combine it with a positive v1 offset.",
		},
	});

const TraceDetailCursorQuery = z
	.string()
	.min(1)
	.max(2048)
	.regex(/^[A-Za-z0-9_-]+$/)
	.optional()
	.openapi({
		param: {
			name: "cursor",
			in: "query",
			description:
				"Opaque, project- and trace-scoped keyset cursor from next_cursor.",
		},
	});

export const TraceStatus = z.enum(["ok", "error"]).openapi("TraceStatus");
const ExactTime = z
	.string()
	.regex(/^\d{1,20}$/)
	.nullable()
	.optional()
	.openapi({
		description:
			"Exact source nanoseconds as a decimal string; null for legacy/internal rows without source precision.",
	});
const RetainedCount = z.number().int().min(0).max(4_294_967_295).optional();
const RetainedAttributes = z
	.array(
		z.object({
			key: z.string().optional(),
			value: z.record(z.string(), z.unknown()).optional(),
		}),
	)
	.optional();
const RetainedContext = z.object({
	attributes: RetainedAttributes,
	dropped_attributes_count: RetainedCount,
});
export const OtlpDetail = z
	.object({
		schema_version: z.literal(1),
		truncated: z.boolean().optional(),
		resource: RetainedContext.optional(),
		resource_schema_url: z.string().optional(),
		scope: RetainedContext.extend({
			name: z.string().optional(),
			version: z.string().optional(),
		}).optional(),
		scope_schema_url: z.string().optional(),
		kind: z.number().int().min(0).max(5).optional(),
		flags: RetainedCount,
		trace_state: z.string().optional(),
		dropped_attributes_count: RetainedCount,
		dropped_events_count: RetainedCount,
		dropped_links_count: RetainedCount,
		status: z
			.object({
				code: z.number().int().min(0).max(2).optional(),
				message: z.string().optional(),
			})
			.optional(),
		attributes: RetainedAttributes,
		events: z
			.array(
				RetainedContext.extend({
					name: z.string().optional(),
					time_unix_nano: ExactTime,
				}),
			)
			.optional(),
		links: z
			.array(
				RetainedContext.extend({
					trace_id: z.string().optional(),
					span_id: z.string().optional(),
					trace_state: z.string().optional(),
					flags: RetainedCount,
				}),
			)
			.optional(),
	})
	.catchall(z.unknown())
	.openapi("OtlpDetail", {
		description:
			"Redacted OTLP resource/scope, schema URLs, attributes, kind, flags, trace_state, status, events, links and dropped counts. Event times are exact decimal nanosecond strings. Bounded to 32 KiB; truncated signals omitted or shortened content, distinct from source dropped counts. Only returned in trace detail/SSE, not lists.",
	});

export const Trace = z
	.object({
		trace_id: z.string(),
		start_time_unix_nano: ExactTime,
		end_time_unix_nano: ExactTime,
		duration_nano: ExactTime,
		project_id: z.string(),
		name: z.string(),
		start_time: z.string().datetime(),
		end_time: z.string().datetime().nullable().optional(),
		duration_ms: z.number().nullable().optional(),
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
		cursor: TraceDetailCursorQuery,
	})
	.strict();

export const TraceEventsQuery = z
	.object({ project_id: ProjectIdQuery })
	.strict();
export const TraceListQuery = PageQuery.extend({
	limit: PageQuery.shape.limit.openapi({
		param: {
			name: "limit",
			in: "query",
			description:
				"Default 50. Zero is allowed. Values above 200 are clamped to 200; malformed, fractional, or negative values return 400.",
		},
	}),
	offset: PageQuery.shape.offset.openapi({
		param: {
			name: "offset",
			in: "query",
			description:
				"v1 offset pagination. Defaults to 0. A malformed, fractional, negative, or offset above 2147483647 returns 400.",
		},
	}),
	project_id: ProjectIdQuery,
	cursor: TraceCursorQuery,
})
	.passthrough()
	.superRefine((value, context) => {
		if (value.cursor && (value.offset ?? 0) > 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "cursor and a positive offset cannot be combined",
				path: ["offset"],
			});
		}
	});

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
		start_time_unix_nano: ExactTime,
		end_time_unix_nano: ExactTime,
		duration_nano: ExactTime,
		otlp: OtlpDetail.nullable().optional(),
		trace_id: z.string(),
		project_id: z.string(),
		parent_observation_id: z.string().nullable().optional(),
		type: z.enum(["span", "event", "generation", "tool"]),
		name: z.string(),
		start_time: z.string().datetime(),
		end_time: z.string().datetime().nullable().optional(),
		duration_ms: z.number().nullable().optional(),
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
