import { z } from "@hono/zod-openapi";

// Reusable parameter schemas
export const IdParam = z.object({
  id: z.string().uuid().openapi({
    param: { name: "id", in: "path" },
    example: "550e8400-e29b-41d4-a716-446655440000",
  }),
});

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().openapi({ example: 50 }),
  offset: z.coerce.number().int().min(0).optional().openapi({ example: 0 }),
});

// Standard error envelope returned by all endpoints (501 stubs and 4xx/5xx real)
export const ErrorCode = z.enum([
  "NOT_IMPLEMENTED",
  "BAD_REQUEST",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
}).openapi("ErrorEnvelope");

export const NotImplementedError = ErrorEnvelope.extend({
  code: z.literal("NOT_IMPLEMENTED"),
  message: z.string(),
}).openapi("NotImplementedError");

// Health response
export const HealthResponse = z.object({
  status: z.literal("ok").or(z.literal("degraded")),
  checks: z.object({
    postgres: z.enum(["up", "down"]),
    clickhouse: z.enum(["up", "down"]),
    redis: z.enum(["up", "down"]),
  }),
}).openapi("HealthResponse");