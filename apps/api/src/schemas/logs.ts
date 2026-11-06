import { z } from "@hono/zod-openapi";

function decimalInteger(signed: boolean) {
	return z
		.union([z.string().max(21), z.number().refine(Number.isSafeInteger)])
		.refine((value) => {
			if (!/^-?\d+$/.test(String(value))) return false;
			const integer = BigInt(value);
			return signed
				? integer >= -9_223_372_036_854_775_808n &&
						integer <= 9_223_372_036_854_775_807n
				: integer >= 0n && integer <= 18_446_744_073_709_551_615n;
		})
		.transform((value) => BigInt(value).toString());
}

export const LogNano = decimalInteger(false);
const uint32 = z.number().int().min(0).max(4_294_967_295);
export type LogAnyValue = {
	stringValue?: string;
	boolValue?: boolean;
	intValue?: string;
	doubleValue?: number | "NaN" | "Infinity" | "-Infinity";
	bytesValue?: string;
	arrayValue?: { values?: LogAnyValue[] };
	kvlistValue?: { values?: LogAttribute[] };
};
export type LogAttribute = { key: string; value?: LogAnyValue };
export const LOG_VALUE_KEYS = new Set([
	"stringValue",
	"boolValue",
	"intValue",
	"doubleValue",
	"bytesValue",
	"arrayValue",
	"kvlistValue",
]);

export const LogValue: z.ZodType<LogAnyValue> = z
	.looseObject({
		stringValue: z.string().optional(),
		boolValue: z.boolean().optional(),
		intValue: decimalInteger(true).optional(),
		doubleValue: z
			.union([z.number(), z.enum(["NaN", "Infinity", "-Infinity"])])
			.optional(),
		bytesValue: z
			.string()
			.regex(/^[A-Za-z0-9+/_-]*={0,2}$/)
			.refine(
				(value) =>
					value.replace(/=+$/, "").length % 4 !== 1 &&
					(!value.includes("=") || value.length % 4 === 0),
			)
			.transform((value) => Buffer.from(value, "base64").toString("base64"))
			.optional(),
		arrayValue: z
			.looseObject({ values: z.array(z.lazy(() => LogValue)).optional() })
			.optional(),
		kvlistValue: z
			.looseObject({ values: z.array(z.lazy(() => LogKeyValue)).optional() })
			.optional(),
	})
	.refine(
		(value) =>
			Object.keys(value).filter((key) => LOG_VALUE_KEYS.has(key)).length <= 1,
	)
	.openapi("LogAnyValue");
export const LogKeyValue: z.ZodType<LogAttribute> = z
	.looseObject({
		key: z.string().max(256),
		value: z.lazy(() => LogValue).optional(),
	})
	.openapi("LogAttribute");
const attributes = z.array(LogKeyValue).max(128).default([]);
const correlationId = (length: number) =>
	z
		.string()
		.regex(new RegExp(`^(?:[0-9a-fA-F]{${length}})?$`))
		.transform((value) =>
			!value || /^0+$/.test(value) ? null : value.toLowerCase(),
		)
		.optional();

export const ExportLogsRequest = z
	.object({
		resourceLogs: z
			.array(
				z.object({
					resource: z
						.object({ attributes, droppedAttributesCount: uint32.default(0) })
						.optional(),
					schemaUrl: z.string().max(2048).default(""),
					scopeLogs: z
						.array(
							z.object({
								scope: z
									.object({
										name: z.string().max(1024).default(""),
										version: z.string().max(1024).default(""),
										attributes,
										droppedAttributesCount: uint32.default(0),
									})
									.optional(),
								schemaUrl: z.string().max(2048).default(""),
								logRecords: z
									.array(
										z.object({
											timeUnixNano: LogNano.default("0"),
											observedTimeUnixNano: LogNano.default("0"),
											severityNumber: z
												.number()
												.int()
												.min(0)
												.max(24)
												.default(0),
											severityText: z.string().max(1024).default(""),
											body: LogValue.optional(),
											attributes,
											traceId: correlationId(32),
											spanId: correlationId(16),
											flags: uint32.default(0),
											droppedAttributesCount: uint32.default(0),
											eventName: z.string().max(1024).default(""),
										}),
									)
									.max(512)
									.default([]),
							}),
						)
						.max(128)
						.default([]),
				}),
			)
			.max(128)
			.default([]),
	})
	.refine(
		(request) =>
			request.resourceLogs.reduce(
				(total, resource) =>
					total +
					resource.scopeLogs.reduce(
						(sum, scope) => sum + scope.logRecords.length,
						0,
					),
				0,
			) <= 2000,
	)
	.openapi("ExportLogsServiceRequest");

export const LogRecord = z
	.object({
		log_id: z.string(),
		project_id: z.string().uuid(),
		time_unix_nano: z.string(),
		observed_time_unix_nano: z.string(),
		ingested_time_unix_nano: z.string(),
		effective_time_unix_nano: z.string(),
		severity_number: z.number().int(),
		severity_text: z.string(),
		trace_id: z.string().nullable(),
		span_id: z.string().nullable(),
		flags: uint32,
		dropped_attributes_count: uint32,
		event_name: z.string(),
		body: LogValue,
		attributes: z.array(LogKeyValue),
		resource: z.object({
			attributes: z.array(LogKeyValue),
			droppedAttributesCount: uint32,
		}),
		scope: z.object({
			name: z.string(),
			version: z.string(),
			attributes: z.array(LogKeyValue),
			droppedAttributesCount: uint32,
		}),
		resource_schema_url: z.string(),
		scope_schema_url: z.string(),
	})
	.openapi("LogRecord");
export type LogRecord = z.infer<typeof LogRecord>;

export const LogListQuery = z
	.object({
		project_id: z.string().uuid(),
		limit: z.coerce.number().int().min(1).max(200).default(50),
		offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
		cursor: z.string().max(2048).optional(),
		"filter[severity_number]": z.coerce
			.number()
			.int()
			.min(0)
			.max(24)
			.optional(),
		"filter[severity_text]": z.string().max(1024).optional(),
		"filter[trace_id]": z
			.string()
			.regex(/^[0-9a-fA-F]{32}$/)
			.optional(),
		"filter[q]": z.string().max(256).optional(),
		"filter[time.from]": z.iso.datetime().optional(),
		"filter[time.to]": z.iso.datetime().optional(),
	})
	.refine((query) => !query.cursor || query.offset === 0);
export const LogList = z
	.object({
		items: z.array(LogRecord),
		total: z.number().int(),
		next_cursor: z.string().optional(),
		response_truncated: z.boolean().optional(),
	})
	.openapi("LogList");
