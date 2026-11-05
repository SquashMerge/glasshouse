import { z } from "@hono/zod-openapi";

export const MAX_OTLP_RESOURCE_SPANS = 128;
export const MAX_OTLP_SCOPE_SPANS_PER_RESOURCE = 128;
export const MAX_OTLP_SPANS_PER_SCOPE = 512;
export const MAX_OTLP_SPANS_PER_REQUEST = 2_000;
export const MAX_OTLP_ATTRIBUTES_PER_RECORD = 128;
export const MAX_OTLP_EVENTS_PER_SPAN = 512;
export const MAX_OTLP_LINKS_PER_SPAN = 512;

export const UnixNano = z
	.union([
		z
			.string()
			.regex(/^\d{1,20}$/)
			.refine(
				(value) =>
					/^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n,
			),
		z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	])
	.transform((value) => BigInt(value).toString());
const UInt32 = z.number().int().min(0).max(4_294_967_295);
const Int64 = z.union([
	z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
	z
		.string()
		.refine(
			(value) =>
				/^-?\d{1,19}$/.test(value) &&
				BigInt(value) >= -9223372036854775808n &&
				BigInt(value) <= 9223372036854775807n,
		),
]);
const Double = z.union([
	z.number(),
	z.literal("NaN"),
	z.literal("Infinity"),
	z.literal("-Infinity"),
]);
const SpanUnixNano = UnixNano.refine(
	(value) => BigInt(value) <= 10413791999999999999n,
	"span timestamp exceeds ClickHouse's supported year 2299",
);
function validInterval(start: string, end?: string | null): boolean {
	return (
		!/^\d{1,20}$/.test(start) ||
		end == null ||
		!/^\d{1,20}$/.test(end) ||
		BigInt(end) >= BigInt(start)
	);
}

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

const KeyValue = z
	.looseObject({
		key: z.string().min(1).max(256),
		value: z.lazy(() => WireAnyValue).optional(),
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

const Attributes = z.array(KeyValue).max(MAX_OTLP_ATTRIBUTES_PER_RECORD);
export const SpanEvent = z.object({
	name: z.string().default(""),
	time_unix_nano: UnixNano.default("0"),
	attributes: Attributes.default([]),
	dropped_attributes_count: UInt32.optional(),
});
export const SpanLink = z.object({
	trace_id: TraceId,
	span_id: SpanId,
	trace_state: z.string().max(512).optional(),
	attributes: Attributes.default([]),
	dropped_attributes_count: UInt32.optional(),
	flags: UInt32.optional(),
});

export const Span = z
	.object({
		trace_id: TraceId,
		span_id: SpanId,
		parent_span_id: ParentSpanId,
		name: z.string().min(1).max(256),
		kind: SpanKind.optional(),
		start_time_unix_nano: SpanUnixNano,
		end_time_unix_nano: SpanUnixNano.optional(),
		attributes: z
			.array(KeyValue)
			.max(MAX_OTLP_ATTRIBUTES_PER_RECORD)
			.optional()
			.default([]),
		status: SpanStatus.optional(),
		events: z.array(SpanEvent).max(MAX_OTLP_EVENTS_PER_SPAN).optional(),
		links: z.array(SpanLink).max(MAX_OTLP_LINKS_PER_SPAN).optional(),
		trace_state: z.string().max(512).optional(),
		flags: UInt32.optional(),
		dropped_attributes_count: UInt32.optional(),
		dropped_events_count: UInt32.optional(),
		dropped_links_count: UInt32.optional(),
	})
	.refine(
		(span) => validInterval(span.start_time_unix_nano, span.end_time_unix_nano),
		"end time precedes start time",
	)
	.openapi("Span");
export type Span = z.infer<typeof Span>;

export const ScopeSpans = z
	.object({
		scope: z
			.object({
				name: z.string().optional(),
				version: z.string().optional(),
				dropped_attributes_count: UInt32.optional(),
				attributes: z
					.array(KeyValue)
					.max(MAX_OTLP_ATTRIBUTES_PER_RECORD)
					.optional(),
			})
			.optional(),
		spans: z.array(Span).max(MAX_OTLP_SPANS_PER_SCOPE).default([]),
		schema_url: z.string().optional(),
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
				dropped_attributes_count: UInt32.optional(),
			})
			.optional(),
		scope_spans: z
			.array(ScopeSpans)
			.max(MAX_OTLP_SCOPE_SPANS_PER_RESOURCE)
			.default([]),
		schema_url: z.string().optional(),
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
	.looseObject({
		stringValue: z.string().nullable().optional(),
		boolValue: z.boolean().nullable().optional(),
		intValue: Int64.nullable().optional(),
		doubleValue: Double.nullable().optional(),
		bytesValue: z.string().nullable().optional(),
		arrayValue: z
			.looseObject({
				values: z
					.array(z.lazy(() => WireAnyValue))
					.nullable()
					.optional(),
			})
			.nullable()
			.optional(),
		kvlistValue: z
			.looseObject({
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
	.looseObject({
		key: KeyValue.shape.key,
		value: z.union([WireAnyValue, z.null()]).optional(),
	})
	.openapi("OtlpWireKeyValue");

const WireEvent = z.object({
	name: z.string().nullable().optional(),
	timeUnixNano: UnixNano.nullable().optional(),
	attributes: z
		.array(WireKeyValue)
		.max(MAX_OTLP_ATTRIBUTES_PER_RECORD)
		.nullable()
		.optional(),
	droppedAttributesCount: UInt32.nullable().optional(),
});
const WireLink = z.object({
	traceId: z.string().regex(/^[0-9a-fA-F]{32}$/),
	spanId: z.string().regex(/^[0-9a-fA-F]{16}$/),
	traceState: z.string().max(512).nullable().optional(),
	attributes: z
		.array(WireKeyValue)
		.max(MAX_OTLP_ATTRIBUTES_PER_RECORD)
		.nullable()
		.optional(),
	droppedAttributesCount: UInt32.nullable().optional(),
	flags: UInt32.nullable().optional(),
});

const WireSpan = z
	.object({
		traceId: z.string().regex(/^[0-9a-fA-F]{32}$/),
		spanId: z.string().regex(/^[0-9a-fA-F]{16}$/),
		parentSpanId: z.string().nullable().optional(),
		name: z.string().min(1).max(256),
		kind: z.number().int().min(0).max(5).nullable().optional(),
		startTimeUnixNano: SpanUnixNano,
		endTimeUnixNano: SpanUnixNano.nullable().optional(),
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
		events: z
			.array(WireEvent)
			.max(MAX_OTLP_EVENTS_PER_SPAN)
			.nullable()
			.optional(),
		links: z.array(WireLink).max(MAX_OTLP_LINKS_PER_SPAN).nullable().optional(),
		traceState: z.string().nullable().optional(),
		flags: UInt32.nullable().optional(),
		droppedAttributesCount: UInt32.nullable().optional(),
		droppedEventsCount: UInt32.nullable().optional(),
		droppedLinksCount: UInt32.nullable().optional(),
	})
	.refine(
		(span) => validInterval(span.startTimeUnixNano, span.endTimeUnixNano),
		"end time precedes start time",
	);

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
							droppedAttributesCount: UInt32.nullable().optional(),
						})
						.nullable()
						.optional(),
					schemaUrl: z.string().nullable().optional(),
					scopeSpans: z
						.array(
							z.object({
								scope: z
									.object({
										name: z.string().nullable().optional(),
										version: z.string().nullable().optional(),
										droppedAttributesCount: UInt32.nullable().optional(),
										attributes: z
											.array(WireKeyValue)
											.max(MAX_OTLP_ATTRIBUTES_PER_RECORD)
											.nullable()
											.optional(),
									})
									.nullable()
									.optional(),
								schemaUrl: z.string().nullable().optional(),
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
