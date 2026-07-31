// Verifies that TraceIdParam (the new 32-hex regex schema) rejects non-hex
// ids and accepts valid OTEL-format trace ids, and that the route that
// uses it (GET /v1/traces/{id} -> handleGetTrace) returns 400 on a bad id.

import { describe, it, expect, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { TraceIdParam } from "../../src/schemas/common";
import { TraceDetailQuery } from "../../src/schemas/traces";
import { getTrace as getTraceRoute } from "../../src/routes/traces";

const VALID_HEX32 = "0123456789abcdef0123456789abcdef";

describe("TraceIdParam (Zod schema)", () => {
	it("accepts a 32-char lowercase hex id", () => {
		expect(TraceIdParam.safeParse({ id: VALID_HEX32 }).success).toBe(true);
	});

	it("accepts an all-zero 32-char hex id", () => {
		expect(TraceIdParam.safeParse({ id: "0".repeat(32) }).success).toBe(true);
	});

	it("rejects a too-short id (3 chars)", () => {
		expect(TraceIdParam.safeParse({ id: "abc" }).success).toBe(false);
	});

	it("rejects a 31-char hex (one short)", () => {
		expect(TraceIdParam.safeParse({ id: "a".repeat(31) }).success).toBe(false);
	});

	it("rejects a 33-char hex (one over)", () => {
		expect(TraceIdParam.safeParse({ id: "a".repeat(33) }).success).toBe(false);
	});

	it("rejects uppercase hex", () => {
		expect(
			TraceIdParam.safeParse({ id: VALID_HEX32.toUpperCase() }).success,
		).toBe(false);
	});

	it("rejects non-hex chars", () => {
		expect(TraceIdParam.safeParse({ id: "z".repeat(32) }).success).toBe(false);
		expect(TraceIdParam.safeParse({ id: "g".repeat(32) }).success).toBe(false);
	});

	it("rejects a UUID (which is what IdParam accepts)", () => {
		expect(
			TraceIdParam.safeParse({ id: "550e8400-e29b-41d4-a716-446655440000" })
				.success,
		).toBe(false);
	});

	it("the route registers /v1/traces/{id} with TraceIdParam (not IdParam)", () => {
		// Sanity-check that the getTrace route has the 32-hex regex baked in.
		// The route's request.params is a Zod schema; we introspect it via the
		// createRoute() result.
		// @hono/zod-openapi stores the original schema on the route object.
		const params = (
			getTraceRoute as unknown as { request: { params?: unknown } }
		).request?.params;
		expect(params).toBeDefined();
		// The schema's safeParse should match the standalone TraceIdParam.
		const standalone = TraceIdParam.safeParse({ id: VALID_HEX32 });
		const routeBound = (
			params as { safeParse: (v: unknown) => { success: boolean } }
		).safeParse({ id: VALID_HEX32 });
		expect(routeBound.success).toBe(true);
		expect(routeBound.success).toBe(standalone.success);
		// And reject "abc" the same way.
		expect(
			(params as { safeParse: (v: unknown) => { success: boolean } }).safeParse(
				{ id: "abc" },
			).success,
		).toBe(false);
	});

	it("requires project_id for trace detail lookups", () => {
		expect(TraceDetailQuery.safeParse({}).success).toBe(false);
		expect(
			TraceDetailQuery.safeParse({
				project_id: "11111111-1111-4111-8111-111111111111",
			}).success,
		).toBe(true);
	});

	it("rejects an unscoped trace detail request before its handler runs", async () => {
		const handler = mock(async () => new Response());
		const app = new OpenAPIHono({
			defaultHook: (result, c) =>
				result.success ? undefined : c.json({ code: "BAD_REQUEST" }, 400),
		});
		app.openapi(getTraceRoute, handler as never);

		const response = await app.request(`http://x/v1/traces/${VALID_HEX32}`);
		expect(response.status).toBe(400);
		expect(handler).not.toHaveBeenCalled();
	});
});
