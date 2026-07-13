import { z } from "@hono/zod-openapi";

// OTLP uses lowercase hex with no "0x" prefix.
// trace_id = 16 bytes (32 hex chars), span_id = 8 bytes (16 hex chars).
const hexBytes = (len: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${len}}$`), `must be ${len} lowercase hex chars`);

export const TraceId = hexBytes(32);
export type TraceId = z.infer<typeof TraceId>;
export const SpanId = hexBytes(16);
export type SpanId = z.infer<typeof SpanId>;
export const ParentSpanId = SpanId.nullable().optional();

const AnyValue = z.union([
  z.object({ stringValue: z.string() }),
  z.object({ boolValue: z.boolean() }),
  z.object({ intValue: z.union([z.number().int(), z.string()]) }),
  z.object({ doubleValue: z.number() }),
  z.object({ stringValue: z.string() }).array(),
  z.object({ kvlistValue: z.object({ values: z.array(z.any()).optional() }) }).optional(),
  z.object({ bytesValue: z.string() }),
]).openapi("AnyValue");

const KeyValue = z.object({
  key: z.string().min(1),
  value: AnyValue.optional(),
}).openapi("KeyValue");

// SpanKind: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER.
export const SpanKind = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
]).openapi("SpanKind");

// Status code: 0=UNSET, 1=OK, 2=ERROR.
export const SpanStatus = z.object({
  code: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  message: z.string().optional(),
}).openapi("SpanStatus");

export const Span = z.object({
  trace_id: TraceId,
  span_id: SpanId,
  parent_span_id: ParentSpanId,
  name: z.string().min(1).max(256),
  kind: SpanKind.optional(),
  start_time_unix_nano: z.union([z.number().int(), z.string()]).transform((v) => Number(v)),
  end_time_unix_nano: z.union([z.number().int(), z.string()]).optional().transform((v) => v === undefined ? undefined : Number(v)),
  attributes: z.array(KeyValue).optional().default([]),
  status: SpanStatus.optional(),
  events: z.array(z.any()).optional(),
  links: z.array(z.any()).optional(),
  trace_state: z.string().optional(),
}).openapi("Span");
export type Span = z.infer<typeof Span>;

export const ScopeSpans = z.object({
  scope: z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    attributes: z.array(KeyValue).optional(),
  }).optional(),
  spans: z.array(Span).min(1),
}).openapi("ScopeSpans");

export const ResourceSpans = z.object({
  resource: z.object({
    attributes: z.array(KeyValue).optional().default([]),
    dropped_attributes_count: z.number().int().optional(),
  }).optional(),
  scope_spans: z.array(ScopeSpans).min(1),
}).openapi("ResourceSpans");

export const ExportTraceServiceRequest = z.object({
  resource_spans: z.array(ResourceSpans).min(1),
}).openapi("ExportTraceServiceRequest");

export const ExportTraceServiceResponse = z.object({
  partial_success: z.object({
    rejected_spans: z.number().int().optional(),
    error_message: z.string().optional(),
  }).optional(),
}).openapi("ExportTraceServiceResponse");
