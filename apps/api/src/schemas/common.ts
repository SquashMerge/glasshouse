import { z } from "@hono/zod-openapi";

export const IdParam = z.object({
	id: z
		.string()
		.uuid()
		.openapi({
			param: { name: "id", in: "path" },
			example: "550e8400-e29b-41d4-a716-446655440000",
		}),
});

// 32-char lowercase hex (OTEL trace_id). Used by trace-scoped routes only;
// IdParam (UUID) stays for agents / experiments / scores / datasets / prompts.
export const TraceIdParam = z.object({
	id: z
		.string()
		.regex(/^[0-9a-f]{32}$/)
		.openapi({
			param: { name: "id", in: "path" },
			example: "0123456789abcdef0123456789abcdef",
		}),
});

const PageNumber = z
	.string()
	.trim()
	.min(1)
	.transform((value) => Number(value))
	.pipe(z.number().finite().int().nonnegative());
const PageOffset = PageNumber.pipe(z.number().max(2_147_483_647));

export const PageQuery = z.object({
	limit: PageNumber.optional().openapi({ example: 50 }),
	offset: PageOffset.optional().openapi({ example: 0 }),
});

export const ErrorCode = z.enum([
	"NOT_IMPLEMENTED",
	"BAD_REQUEST",
	"NOT_FOUND",
	"UNAUTHORIZED",
	"FORBIDDEN",
	"CONFLICT",
	"PAYLOAD_TOO_LARGE",
	"INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z
	.object({
		code: ErrorCode,
		message: z.string(),
		details: z.record(z.string(), z.unknown()).optional(),
	})
	.openapi("ErrorEnvelope");

export const NotImplementedError = ErrorEnvelope.extend({
	code: z.literal("NOT_IMPLEMENTED"),
	message: z.string(),
}).openapi("NotImplementedError");

export const HealthResponse = z
	.object({
		status: z.literal("ok").or(z.literal("degraded")),
		checks: z.object({
			postgres: z.enum(["up", "down"]),
			clickhouse: z.enum(["up", "down"]),
			valkey: z.enum(["up", "down"]),
		}),
	})
	.openapi("HealthResponse");
