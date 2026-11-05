import { z } from "@hono/zod-openapi";

export const MAX_OTLP_RESOURCE_SPANS = 128;
export const MAX_OTLP_SCOPE_SPANS_PER_RESOURCE = 128;
export const MAX_OTLP_SPANS_PER_SCOPE = 512;
export const MAX_OTLP_SPANS_PER_REQUEST = 2_000;
export const MAX_OTLP_ATTRIBUTES_PER_RECORD = 128;

// OTLP uses lowercase hex with no "0x" prefix. The HTTP adapter canonicalizes
// standards-compatible JSON before it reaches this legacy-safe schema.
// trace_id = 16 bytes (32 hex chars), span_id = 8 bytes (16 hex chars).
const hexBytes = (len: number) =>
	z
		.string()
		.regex(
			new RegExp(`^[0-9a-f]{${len}}$`),
			`must be ${len} lowercase hex chars`,
		);

export const TraceId = hexBytes(32);
export type TraceId = z.infer<typeof TraceId>;
export const SpanId = hexBytes(16);
export type SpanId = z.infer<typeof SpanId>;
export const ParentSpanId = SpanId.nullable().optional();

const KvlistValue = z
	.object({ values: z.array(z.any()).optional() })
	.openapi("KvlistValue");

const AnyValue = z
	.union([
		z.strictObject({}),
		z.object({ stringValue: z.string() }),
		z.object({ boolValue: z.boolean() }),
		z.object({ intValue: z.union([z.number().int(), z.string()]) }),
		z.object({ doubleValue: z.number() }),
		z.object({ arrayValue: z.object({ values: z.array(z.any()).optional() }) }),
		z.object({ kvlistValue: KvlistValue }).optional(),
		z.object({ bytesValue: z.string() }),
	])
	.openapi("AnyValue");

const KeyValue = z
	.object({
		key: z.string().min(1).max(256),
		value: AnyValue.optional(),
	})
	.openapi("KeyValue");

// SpanKind: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER.
export const SpanKind = z
	.union([
		z.literal(0),
		z.literal(1),
		z.literal(2),
		z.literal(3),
		z.literal(4),
		z.literal(5),
	])
	.openapi("SpanKind");

// Status code: 0=UNSET, 1=OK, 2=ERROR.
export const SpanStatus = z
	.object({
		code: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
		message: z.string().optional(),
	})
	.openapi("SpanStatus");

export const Span = z
	.object({
		trace_id: TraceId,
		span_id: SpanId,
		parent_span_id: ParentSpanId,
		name: z.string().min(1).max(256),
		kind: SpanKind.optional(),
		start_time_unix_nano: z
			.union([z.number().refine(Number.isInteger), z.string()])
			.transform((v) => Number(v)),
		end_time_unix_nano: z
			.union([z.number().refine(Number.isInteger), z.string()])
			.optional()
			.transform((v) => (v === undefined ? undefined : Number(v))),
		attributes: z
			.array(KeyValue)
			.max(MAX_OTLP_ATTRIBUTES_PER_RECORD)
			.optional()
			.default([]),
		status: SpanStatus.optional(),
		events: z.array(z.any()).optional(),
		links: z.array(z.any()).optional(),
		trace_state: z.string().max(512).optional(),
	})
	.openapi("Span");
export type Span = z.infer<typeof Span>;

export const ScopeSpans = z
	.object({
		scope: z
			.object({
				name: z.string().optional(),
				version: z.string().optional(),
				attributes: z
					.array(KeyValue)
					.max(MAX_OTLP_ATTRIBUTES_PER_RECORD)
					.optional(),
			})
			.optional(),
		spans: z.array(Span).max(MAX_OTLP_SPANS_PER_SCOPE).default([]),
	})
	.openapi("ScopeSpans");

export const ResourceSpans = z
	.object({
		resource: z
			.object({
				attributes: z
					.array(KeyValue)
					.max(MAX_OTLP_ATTRIBUTES_PER_RECORD)
					.optional()
					.default([]),
				dropped_attributes_count: z.number().int().optional(),
			})
			.optional(),
		scope_spans: z
			.array(ScopeSpans)
			.max(MAX_OTLP_SCOPE_SPANS_PER_RESOURCE)
			.default([]),
	})
	.openapi("ResourceSpans");

export const ExportTraceServiceRequest = z
	.object({
		resource_spans: z.array(ResourceSpans).min(1).max(MAX_OTLP_RESOURCE_SPANS),
	})
	.superRefine((request, ctx) => {
		const spanCount = request.resource_spans.reduce(
			(total, resourceSpan) =>
				total +
				resourceSpan.scope_spans.reduce(
					(scopeTotal, scopeSpan) => scopeTotal + scopeSpan.spans.length,
					0,
				),
			0,
		);
		if (spanCount > MAX_OTLP_SPANS_PER_REQUEST)
			ctx.addIssue({
				code: "custom",
				message: `request contains more than ${MAX_OTLP_SPANS_PER_REQUEST} spans`,
			});
	})
	.openapi("ExportTraceServiceRequest");

const WireAnyValue: z.ZodType<Record<string, unknown>> = z
	.object({
		stringValue: z.string().nullable().optional(),
		boolValue: z.boolean().nullable().optional(),
		intValue: z.union([z.number().int(), z.string()]).nullable().optional(),
		doubleValue: z.number().nullable().optional(),
		bytesValue: z.string().nullable().optional(),
		arrayValue: z
			.object({
				values: z
					.array(z.lazy(() => WireAnyValue))
					.nullable()
					.optional(),
			})
			.nullable()
			.optional(),
		kvlistValue: z
			.object({
				values: z
					.array(z.lazy(() => WireKeyValue))
					.nullable()
					.optional(),
			})
			.nullable()
			.optional(),
	})
	.openapi("OtlpWireAnyValue");

const WireKeyValue = z
	.object({
		key: KeyValue.shape.key,
		value: z.union([WireAnyValue, z.null()]).optional(),
	})
	.openapi("OtlpWireKeyValue");

const WireUnsupportedMessage = z.object({
	attributes: z.array(WireKeyValue).nullable().optional(),
});

const WireSpan = z.object({
	traceId: z.string().regex(/^[0-9a-fA-F]{32}$/),
	spanId: z.string().regex(/^[0-9a-fA-F]{16}$/),
	parentSpanId: z.string().nullable().optional(),
	name: z.string().min(1).max(256),
	kind: z.number().int().min(0).max(5).nullable().optional(),
	startTimeUnixNano: z.union([z.string(), z.number().int()]),
	endTimeUnixNano: z
		.union([z.string(), z.number().int()])
		.nullable()
		.optional(),
	attributes: z
		.array(WireKeyValue)
		.max(MAX_OTLP_ATTRIBUTES_PER_RECORD)
		.nullable()
		.optional(),
	status: z
		.object({
			code: z
				.union([z.literal(0), z.literal(1), z.literal(2)])
				.nullable()
				.optional(),
			message: z.string().nullable().optional(),
		})
		.nullable()
		.optional(),
	events: z.array(WireUnsupportedMessage).nullable().optional(),
	links: z.array(WireUnsupportedMessage).nullable().optional(),
	traceState: z.string().nullable().optional(),
});

export const OtlpWireRequest = z
	.object({
		resourceSpans: z
			.array(
				z.object({
					resource: z
						.object({
							attributes: z
								.array(WireKeyValue)
								.max(MAX_OTLP_ATTRIBUTES_PER_RECORD)
								.nullable()
								.optional(),
							droppedAttributesCount: z.number().int().nullable().optional(),
						})
						.nullable()
						.optional(),
					scopeSpans: z
						.array(
							z.object({
								scope: z
									.object({
										name: z.string().nullable().optional(),
										version: z.string().nullable().optional(),
										attributes: z
											.array(WireKeyValue)
											.max(MAX_OTLP_ATTRIBUTES_PER_RECORD)
											.nullable()
											.optional(),
									})
									.nullable()
									.optional(),
								spans: z
									.array(WireSpan)
									.max(MAX_OTLP_SPANS_PER_SCOPE)
									.nullable()
									.optional(),
							}),
						)
						.max(MAX_OTLP_SCOPE_SPANS_PER_RESOURCE)
						.nullable()
						.optional(),
				}),
			)
			.max(MAX_OTLP_RESOURCE_SPANS)
			.nullable()
			.optional(),
	})
	.openapi("OtlpWireRequest");

export const OtlpWireResponse = z
	.object({
		partialSuccess: z
			.object({
				rejectedSpans: z.union([z.string(), z.number().int()]).optional(),
				errorMessage: z.string().optional(),
			})
			.optional(),
	})
	.openapi("OtlpWireResponse");

export const OtlpError = z
	.object({ message: z.string().optional() })
	.openapi("OtlpError");

export const ExportTraceServiceResponse = z
	.object({
		partial_success: z
			.object({
				rejected_spans: z.number().int().optional(),
				error_message: z.string().optional(),
			})
			.optional(),
	})
	.openapi("ExportTraceServiceResponse");
