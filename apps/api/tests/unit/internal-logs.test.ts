import { describe, expect, it } from "bun:test";
import { InternalLogQuery } from "../../src/schemas/internal-logs";
import {
	decodeInternalLogCursor,
	encodeInternalLogCursor,
	INTERNAL_LOG_MAX_PENDING,
	INTERNAL_LOG_ORGANIZATION_LOCK_SEED,
	internalLogRoute,
	internalLogRequestContext,
	listInternalLogs,
	persistInternalLog,
	cleanupExpiredInternalLogs,
	createInternalLogCollector,
} from "../../src/db/internal-logs";
import { createApiApp } from "../../src/index";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";

const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION = "00000000-0000-4000-8000-000000000002";

describe("internal operational log persistence", () => {
	it("never forwards request IDs or raw path segments from middleware collection", async () => {
		const collected: Array<{
			organizationId: string;
			severity: string;
			context: Record<string, unknown>;
		}> = [];
		const app = createApiApp({
			authenticate: () => async (c, next) => {
				c.set(TRUSTED_TENANT_CONTEXT_KEY, {
					actor: "test",
					actorId: "11111111-1111-4111-8111-111111111111",
					organizationId: ORGANIZATION,
				});
				await next();
			},
			collectInternalLog: (entry) => {
				collected.push(entry);
				return true;
			},
		});

		await app.request("http://test/v1/admin/customer-secret", {
			headers: { "x-request-id": "attacker-request-id" },
		});

		expect(collected).toEqual([
			{
				organizationId: ORGANIZATION,
				severity: "warn",
				context: {
					route: "admin",
					method: "GET",
					status: 404,
					duration_ms: expect.any(Number),
				},
			},
		]);
	});

	it("collects only fixed, allowlisted route groups", () => {
		expect(internalLogRoute("/v1/prompts/customer-private-slug/render")).toBe(
			"prompts",
		);
		expect(internalLogRoute("/v1/admin/logs")).toBe("admin");
		expect(internalLogRoute("/v1/not-a-real-route/customer-secret")).toBe(
			undefined,
		);
	});

	it("does not collect log paging requests", () => {
		expect(
			internalLogRequestContext("/v1/admin/logs", "GET", 200, 1),
		).toBeUndefined();
		expect(
			internalLogRequestContext("/v1/admin/other", "GET", 200, 1)?.route,
		).toBe("admin");
	});

	it("stores only the fixed source/message and safe primitive request outcome context", async () => {
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		let released = false;
		const client = {
			query: async (sql: string, values: unknown[]) => {
				calls.push({ sql, values });
				return { rows: [] };
			},
			release() {
				released = true;
			},
		};
		const pool = {
			connect: async () => client,
		};

		await persistInternalLog(pool as never, {
			organizationId: ORGANIZATION,
			severity: "warn",
			context: {
				route: "prompts",
				method: "POST",
				status: 403,
				duration_ms: 12.4,
			},
		});

		expect(calls.map((call) => call.sql)).toEqual([
			"BEGIN",
			"SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
			expect.stringContaining("INSERT INTO internal_log_entries"),
			expect.stringContaining("WITH overflow AS"),
			"COMMIT",
		]);
		expect(calls[1]?.values).toEqual([
			ORGANIZATION,
			INTERNAL_LOG_ORGANIZATION_LOCK_SEED,
		]);
		expect(calls[2]?.values.slice(2, 4)).toEqual([
			"api",
			"API request outcome",
		]);
		expect(JSON.parse(String(calls[2]?.values[4]))).toEqual({
			route: "prompts",
			method: "POST",
			status: 403,
			duration_ms: 12,
		});
		expect(calls[3]?.sql).not.toContain("INTERVAL '14 days'");
		expect(calls[3]?.sql).toContain("OFFSET $2");
		expect(calls[3]?.sql).toContain("LIMIT $3");
		expect(calls[3]?.values).toEqual([ORGANIZATION, 50_000, 1_000]);
		expect(released).toBe(true);
	});

	it("rolls back and releases the connection when collection fails", async () => {
		const calls: string[] = [];
		let released = false;
		const client = {
			query: async (sql: string) => {
				calls.push(sql);
				if (sql.includes("INSERT INTO internal_log_entries"))
					throw new Error("storage unavailable");
				return { rows: [] };
			},
			release() {
				released = true;
			},
		};
		await expect(
			persistInternalLog({ connect: async () => client } as never, {
				organizationId: ORGANIZATION,
				severity: "info",
				context: {
					route: "prompts",
					method: "GET",
					status: 200,
					duration_ms: 1,
				},
			}),
		).rejects.toThrow("storage unavailable");
		expect(calls).toEqual(expect.arrayContaining(["BEGIN", "ROLLBACK"]));
		expect(released).toBe(true);
	});

	it("drops malformed context before it reaches storage", async () => {
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		await persistInternalLog(
			{
				connect: async () => ({
					query: async (sql: string, values: unknown[]) => {
						calls.push({ sql, values });
						return { rows: [] };
					},
					release() {},
				}),
			} as never,
			{
				organizationId: ORGANIZATION,
				severity: "info",
				context: {
					route: "prompts",
					method: "GET",
					status: 200,
					duration_ms: Number.NaN,
				},
			},
		);
		expect(calls).toEqual([]);
	});

	it("bounds the in-memory collector instead of creating an unbounded async queue", async () => {
		let resolveFirst: (() => void) | undefined;
		const collector = createInternalLogCollector({
			connect: async () => ({
				query: async () =>
					await new Promise<{ rows: [] }>((resolve) => {
						resolveFirst = () => resolve({ rows: [] });
					}),
				release() {},
			}),
		} as never);
		const entry = {
			organizationId: ORGANIZATION,
			severity: "info" as const,
			context: {
				route: "projects" as const,
				method: "GET" as const,
				status: 200,
				duration_ms: 1,
			},
		};
		expect(collector.record(entry)).toBe(true);
		for (let index = 0; index < INTERNAL_LOG_MAX_PENDING; index++)
			collector.record(entry);
		expect(collector.pending()).toBeLessThanOrEqual(
			INTERNAL_LOG_MAX_PENDING + 1,
		);
		expect(collector.record(entry)).toBe(false);
		expect(collector.healthy()).toBe(false);
		resolveFirst?.();
		collector.close();
	});
});

describe("internal operational log cursor", () => {
	it("compares time bounds chronologically across offsets and microseconds", () => {
		expect(
			InternalLogQuery.safeParse({
				time_from: "2026-01-01T10:00:00+02:00",
				time_to: "2026-01-01T09:00:00Z",
			}).success,
		).toBe(true);
		expect(
			InternalLogQuery.safeParse({
				time_from: "2026-01-01T09:00:00-02:00",
				time_to: "2026-01-01T10:00:00Z",
			}).success,
		).toBe(false);
		expect(
			InternalLogQuery.safeParse({
				time_from: "2026-01-01T00:00:00.000002Z",
				time_to: "2026-01-01T00:00:00.000001Z",
			}).success,
		).toBe(false);
	});
	it("rejects invalid calendar timestamps while preserving valid microseconds", () => {
		const cursor = (recorded_at: string) =>
			encodeInternalLogCursor(
				ORGANIZATION,
				{},
				{
					recorded_at,
					id: "11111111-1111-4111-8111-111111111111",
				},
			);
		for (const timestamp of [
			"0000-01-01T00:00:00.0Z",
			"2026-02-30T00:00:00.0Z",
			"2026-99-99T00:00:00.0Z",
		]) {
			expect(() =>
				decodeInternalLogCursor(cursor(timestamp), ORGANIZATION, {}),
			).toThrow("Invalid or mismatched internal log cursor");
		}
		expect(
			decodeInternalLogCursor(
				cursor("2024-02-29T23:59:59.123456Z"),
				ORGANIZATION,
				{},
			)?.recorded_at,
		).toBe("2024-02-29T23:59:59.123456Z");
	});
	it("binds a cursor to its organization and the complete filter set", () => {
		const filters = {
			level: "error",
			source: "api",
			search: "timeout",
			timeFrom: "2026-11-01T00:00:00.000Z",
			timeTo: undefined,
		};
		const cursor = encodeInternalLogCursor(ORGANIZATION, filters, {
			recorded_at: "2026-11-01T00:01:00.000Z",
			id: "11111111-1111-4111-8111-111111111111",
		});
		expect(decodeInternalLogCursor(cursor, ORGANIZATION, filters)).toEqual({
			recorded_at: "2026-11-01T00:01:00.000Z",
			id: "11111111-1111-4111-8111-111111111111",
		});
		expect(() =>
			decodeInternalLogCursor(cursor, OTHER_ORGANIZATION, filters),
		).toThrow("Invalid or mismatched internal log cursor");
		expect(() =>
			decodeInternalLogCursor(cursor, ORGANIZATION, {
				...filters,
				search: "other",
			}),
		).toThrow("Invalid or mismatched internal log cursor");
		const malformedPayload = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		) as Record<string, unknown>;
		malformedPayload.recorded_at = "not-a-timestamp";
		const malformedTimestamp = Buffer.from(
			JSON.stringify(malformedPayload),
		).toString("base64url");
		expect(() =>
			decodeInternalLogCursor(malformedTimestamp, ORGANIZATION, filters),
		).toThrow("Invalid or mismatched internal log cursor");
	});

	it("queries only the trusted organization with stable keyset ordering", async () => {
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		const pool = {
			query: async (sql: string, values: unknown[]) => {
				calls.push({ sql, values });
				return {
					rows: [
						{
							id: "11111111-1111-4111-8111-111111111111",
							recorded_at: "2026-11-01T00:01:00.123456Z",
							severity: "error",
							source: "api",
							message: "Request failed",
							context: { status: 500 },
							total: "1",
						},
					],
				};
			},
		};
		const result = await listInternalLogs(pool, ORGANIZATION, {
			limit: 25,
			level: "error",
			source: "api",
			search: "failed",
		});

		expect(result.total).toBe(1);
		expect(calls[0]?.sql).toContain("organization_id = $1");
		expect(calls[0]?.sql).toContain(
			"recorded_at >= now() - INTERVAL '14 days'",
		);
		expect(calls[0]?.sql).toContain("HH24:MI:SS.US");
		expect(calls[0]?.sql).toContain(
			"ORDER BY cursor_recorded_at DESC, id DESC",
		);
		expect(calls[0]?.values).toContain(ORGANIZATION);
		expect(calls[0]?.values).not.toContain(OTHER_ORGANIZATION);
	});

	it("preserves PostgreSQL microseconds in the response and cursor", async () => {
		const pool = {
			query: async () => ({
				rows: [
					{
						id: "11111111-1111-4111-8111-111111111111",
						recorded_at: "2026-11-01T00:01:00.123456Z",
						severity: "info",
						source: "api",
						message: "API request outcome",
						context: {
							route: "projects",
							method: "GET",
							status: 200,
							duration_ms: 1,
						},
						total: "2",
					},
					{
						id: "22222222-2222-4222-8222-222222222222",
						recorded_at: "2026-11-01T00:01:00.123455Z",
						severity: "info",
						source: "api",
						message: "API request outcome",
						context: {},
						total: "2",
					},
				],
			}),
		};
		const page = await listInternalLogs(pool, ORGANIZATION, { limit: 1 });
		expect(page.items[0]?.recorded_at).toBe("2026-11-01T00:01:00.123456Z");
		expect(page.nextCursor?.recorded_at).toBe("2026-11-01T00:01:00.123456Z");
	});
});

describe("internal operational log cleanup", () => {
	it("uses a transaction-scoped advisory lock and bounded expired-row batch", async () => {
		const calls: Array<{ sql: string; values?: unknown[] }> = [];
		const client = {
			query: async (sql: string, values?: unknown[]) => {
				calls.push({ sql, values });
				if (sql.includes("pg_try_advisory_xact_lock"))
					return { rows: [{ acquired: true }] };
				if (sql.startsWith("WITH expired"))
					return { rows: [{ deleted: "1" }], rowCount: 1 };
				return { rows: [] };
			},
			release() {},
		};
		await expect(
			cleanupExpiredInternalLogs({ connect: async () => client } as never),
		).resolves.toBe(1);
		expect(calls.map((call) => call.sql)).toEqual(
			expect.arrayContaining(["BEGIN", "COMMIT"]),
		);
		expect(
			calls.find((call) => call.sql.startsWith("WITH expired"))?.sql,
		).toContain("LIMIT $1");
	});
});
