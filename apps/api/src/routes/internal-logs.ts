import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Pool } from "pg";
import { pgPool } from "../db/postgres.js";
import {
	assertInternalLogAccess,
	decodeInternalLogCursor,
	encodeInternalLogCursor,
	internalLogCollectionEnabled,
	INTERNAL_LOG_RETENTION_DAYS,
	InternalLogAccessDeniedError,
	InvalidInternalLogCursorError,
	listAuthorizedInternalLogs,
} from "../db/internal-logs.js";
import {
	InternalLogErrorResponses,
	InternalLogList,
	InternalLogQuery,
} from "../schemas/internal-logs.js";
import { trustedTenant } from "../tenancy.js";
import { logger } from "../lib/logger.js";

export const listInternalLogsRoute = createRoute({
	method: "get",
	path: "/v1/admin/logs",
	tags: ["administration"],
	summary: "List tenant-scoped internal operational logs",
	description:
		"Returns retained API operational records for the authenticated Organization only. Records are sanitized before persistence, sorted by recorded_at DESC and id DESC, and continued with an opaque filter-bound cursor.",
	security: [{ basicAuth: [] }],
	request: { query: InternalLogQuery },
	responses: {
		200: {
			description: "Internal operational logs",
			content: { "application/json": { schema: InternalLogList } },
		},
		...InternalLogErrorResponses,
	},
});

export function createHandleListInternalLogs(
	getPool: () => Pick<Pool, "connect"> = pgPool,
) {
	return async function handleListInternalLogs(c: Context): Promise<Response> {
		try {
			const tenant = trustedTenant(c);
			const query = (
				c.req as {
					valid: (target: "query") => {
						limit: number;
						cursor?: string;
						level?: "debug" | "info" | "warn" | "error";
						source?: string;
						q?: string;
						time_from?: string;
						time_to?: string;
					};
				}
			).valid("query");
			const pool = getPool();
			if (!internalLogCollectionEnabled()) {
				await assertInternalLogAccess(pool, tenant);
				return c.json(
					{
						code: "SERVICE_UNAVAILABLE",
						message:
							"Internal log collection is unavailable on this deployment",
					},
					503,
				);
			}
			const filters = {
				level: query.level,
				source: query.source,
				search: query.q,
				timeFrom: query.time_from,
				timeTo: query.time_to,
			};
			const cursor = decodeInternalLogCursor(
				query.cursor,
				tenant.organizationId,
				filters,
			);
			const page = await listAuthorizedInternalLogs(pool, tenant, {
				...filters,
				limit: query.limit,
				cursor,
			});
			return c.json({
				items: page.items,
				total: page.total,
				...(page.nextCursor
					? {
							next_cursor: encodeInternalLogCursor(
								tenant.organizationId,
								filters,
								page.nextCursor,
							),
						}
					: {}),
				sources: ["api"],
				retention_days: INTERNAL_LOG_RETENTION_DAYS,
			});
		} catch (cause) {
			if (cause instanceof InternalLogAccessDeniedError)
				return c.json(
					{ code: "FORBIDDEN", message: "Admin access required" },
					403,
				);
			if (cause instanceof InvalidInternalLogCursorError)
				return c.json({ code: "BAD_REQUEST", message: cause.message }, 400);
			logger.error("internal_logs.request_failed", cause);
			return c.json(
				{ code: "INTERNAL", message: "Could not load internal logs" },
				500,
			);
		}
	};
}

export const handleListInternalLogs = createHandleListInternalLogs();
