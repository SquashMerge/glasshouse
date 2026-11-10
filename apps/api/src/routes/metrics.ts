import { createHash, createHmac, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ch } from "../db/clickhouse.js";
import { approvedRedaction } from "../db/governance.js";
import { metricIdentityKey } from "../db/metric-identity.js";
import { pgPool } from "../db/postgres.js";
import { policyRedactionOptions } from "../db/redact.js";
import { insertWithDeadline } from "../db/traces-writer.js";
import { logger } from "../lib/logger.js";
import {
	InvalidMetricExport,
	METRIC_LIMITS,
	MetricProjectConflict,
	metricSeriesId,
	normalizeMetricExport,
	redactMetricPoint,
} from "../lib/otlp-metrics.js";
import { decodeOtlpMetricExport } from "../lib/otlp-protobuf.js";
import {
	otlpErrorResponse,
	otlpSuccessResponse,
} from "../lib/otlp-response.js";
import { isTransientStorageFailure } from "../lib/transient-storage-error.js";
import { parseBodySizeLimit } from "../middleware/body-size.js";
import {
	type ActiveAuthorizedProjectScope,
	resolveTenantProject,
	TenantScopeError,
	trustedTenant,
	withActiveAuthorizedProjectLock,
} from "../tenancy.js";

const binary = z.string().openapi({ type: "string", format: "binary" });
const jsonObject = z.record(z.string(), z.unknown());
export const ingestMetrics = createRoute({
	method: "post",
	path: "/v1/metrics",
	tags: ["metrics"],
	summary: "OTLP metrics export",
	description:
		"OTLP JSON or protobuf, optionally gzip. Gauge, Sum, Histogram, ExponentialHistogram and Summary are validated atomically before persistence. Decimal strings preserve 64-bit values and nanoseconds. Limits: 2,000 metrics/points per export, 128 attributes per record, 4,096 buckets, 32 exemplars, 1,024 quantiles per point, 32 nesting levels and 100,000 inspected nodes. Oversized or invalid distributions reject the whole export; no truncation or synthetic aggregation.",
	security: [
		{ sessionCookie: [], csrfHeader: [] },
		{ basicAuth: [] },
		{ bearerAuth: [] },
	],
	request: {
		headers: z.object({ "x-glasshouse-project-id": z.string().uuid() }),
		body: {
			required: true,
			content: {
				"application/json": {
					schema: z.object({
						resourceMetrics: z.array(jsonObject).nullable().optional(),
					}),
				},
				"application/x-protobuf": { schema: binary },
				"application/protobuf": { schema: binary },
			},
		},
	},
	responses: {
		200: {
			description: "All points stored (or identical-byte retry deduplicated)",
			content: {
				"application/json": { schema: z.object({}) },
				"application/x-protobuf": { schema: binary },
			},
		},
		400: { description: "Invalid metrics export" },
		401: { description: "Authentication required" },
		404: {
			description: "Project unavailable or resource provenance conflicts",
		},
		413: { description: "Export exceeds limits" },
		415: { description: "Unsupported encoding" },
		500: { description: "Storage failure" },
		503: { description: "Retryable storage failure" },
	},
});
export const listMetrics = createRoute({
	method: "get",
	path: "/v1/metrics",
	tags: ["metrics"],
	summary: "List retained metric points",
	description:
		"Project-authorized product read, newest nanosecond timestamp first. Attributes and data_point are typed OTLP JSON; integers are decimal strings. Pages are capped at 200 points and 256 KiB; follow next_cursor. No aggregation or temporality conversion is performed.",
	request: {
		query: z.object({
			project_id: z.string().uuid(),
			limit: z.coerce.number().int().min(1).max(200).default(50),
			name: z.string().max(1_024).optional(),
			cursor: z.string().max(2_048).optional(),
		}),
	},
	responses: {
		200: {
			description: "Retained points",
			content: {
				"application/json": {
					schema: z.object({
						items: z.array(jsonObject),
						next_cursor: z.string().nullable(),
					}),
				},
			},
		},
		400: { description: "Invalid query" },
		401: { description: "Authentication required" },
		404: { description: "Project unavailable" },
		500: { description: "Read failed" },
	},
});

export async function handleMetricExport(
	req: Request,
	tenant: ActiveAuthorizedProjectScope,
): Promise<Response> {
	const type =
		req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ??
		"application/json";
	if (
		![
			"application/json",
			"application/x-protobuf",
			"application/protobuf",
		].includes(type)
	)
		return otlpErrorResponse(req, 415);
	const limit = parseBodySizeLimit(process.env.API_MAX_BODY_BYTES);
	let body: Uint8Array;
	let points: ReturnType<typeof normalizeMetricExport>;
	try {
		body = new Uint8Array(await req.arrayBuffer());
		if (body.byteLength > limit) return otlpErrorResponse(req, 413);
		const encoding = req.headers.get("content-encoding");
		if (encoding?.toLowerCase() === "gzip")
			body = gunzipSync(body, { maxOutputLength: limit });
		else if (encoding) return otlpErrorResponse(req, 415);
		if (body.byteLength > limit) return otlpErrorResponse(req, 413);
		points = normalizeMetricExport(
			type === "application/json"
				? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
				: decodeOtlpMetricExport(body),
			tenant.projectId,
		);
	} catch (cause) {
		if (cause instanceof MetricProjectConflict)
			return otlpErrorResponse(req, 404);
		return otlpErrorResponse(
			req,
			(cause as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE" ? 413 : 400,
		);
	}
	for (const point of points) {
		const selectors = point.resource_attributes.filter(
			(a) => a.key === "glasshouse.project.id",
		);
		if (
			selectors.some(
				(a) =>
					typeof a.value?.stringValue !== "string" ||
					a.value.stringValue.toLowerCase() !== tenant.projectId,
			)
		)
			throw new TenantScopeError("Conflicting resource Project");
	}
	const digest = createHash("sha256")
		.update(
			JSON.stringify([
				"otlp-metrics-wire-v1",
				tenant.organizationId,
				tenant.projectId,
				type === "application/json" ? "json" : "protobuf",
			]),
		)
		.update(body)
		.digest("hex");
	try {
		await withActiveAuthorizedProjectLock(
			pgPool(),
			tenant,
			async (client) => {
				const policy = await approvedRedaction(
					client,
					tenant.organizationId,
					tenant.projectId,
				);
				const options = policyRedactionOptions(
					policy ?? { mode: "none", keys: [] },
				);
				const key = await metricIdentityKey(
					client,
					tenant.organizationId,
					tenant.projectId,
				);
				let bytes = 0;
				const values = points.map((point, index) => {
					const series_id = metricSeriesId(
						point,
						tenant.organizationId,
						tenant.projectId,
						key,
					);
					const redacted = redactMetricPoint(
						point,
						options.redactKeys,
						options.redactInput,
					);
					const row = {
						...redacted,
						organization_id: tenant.organizationId,
						project_id: tenant.projectId,
						physical_row_id: randomUUID(),
						series_id,
						point_id: createHmac("sha256", key)
							.update(`metrics-point-v2:${digest}:${index}`)
							.digest("hex"),
						time_unix_nano: String(point.data_point.timeUnixNano),
						resource_attributes: JSON.stringify(redacted.resource_attributes),
						scope_attributes: JSON.stringify(redacted.scope_attributes),
						metric_metadata: JSON.stringify(redacted.metric_metadata),
						data_point: JSON.stringify(redacted.data_point),
					};
					const size = Buffer.byteLength(JSON.stringify(row));
					bytes += size;
					if (size > METRIC_LIMITS.rowBytes || bytes > METRIC_LIMITS.batchBytes)
						throw new InvalidMetricExport();
					return row;
				});
				if (values.length)
					await insertWithDeadline(
						ch(),
						{
							table: "metrics",
							values,
							format: "JSONEachRow",
							clickhouse_settings: {
								insert_deduplicate: 1,
								insert_deduplication_token: `glasshouse:otlp:metrics:${digest}`,
							},
						},
						30_000,
					);
			},
			"ingest",
		);
	} catch (cause) {
		if (cause instanceof TenantScopeError) throw cause;
		if (cause instanceof InvalidMetricExport)
			return otlpErrorResponse(req, 400);
		logger.error("otlp.metrics_persist_failed", undefined, {
			project_id: tenant.projectId,
		});
		return otlpErrorResponse(req, isTransientStorageFailure(cause) ? 503 : 500);
	}
	return otlpSuccessResponse(req);
}

type StoredMetric = Record<string, unknown> & {
	point_id: string;
	time_unix_nano: string;
	physical_row_id: string;
};
const physicalMetricId =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export async function handleListMetrics(c: Context): Promise<Response> {
	const projectId = c.req.query("project_id")!;
	try {
		const tenant = await resolveTenantProject(
			pgPool(),
			trustedTenant(c),
			projectId,
		);
		const limit = Number(c.req.query("limit") ?? 50);
		const name = c.req.query("name");
		let cursor:
			| {
					organization: string;
					project: string;
					name: string | null;
					time: string;
					id: string;
					row?: string;
			  }
			| undefined;
		if (c.req.query("cursor")) {
			try {
				cursor = JSON.parse(
					Buffer.from(c.req.query("cursor")!, "base64url").toString(),
				);
				if (
					!cursor ||
					cursor.organization !== tenant.organizationId ||
					cursor.project !== tenant.projectId ||
					cursor.name !== (name ?? null) ||
					typeof cursor.time !== "string" ||
					typeof cursor.id !== "string" ||
					(cursor.row !== undefined &&
						(typeof cursor.row !== "string" ||
							!physicalMetricId.test(cursor.row))) ||
					!/^\d{1,20}$/.test(cursor.time) ||
					BigInt(cursor.time) > (1n << 64n) - 1n ||
					!/^[a-f0-9]{64}$/.test(cursor.id)
				)
					throw new Error();
			} catch {
				return c.json(
					{ code: "BAD_REQUEST", message: "Invalid metrics cursor" },
					400,
				);
			}
		}
		return await withActiveAuthorizedProjectLock(
			pgPool(),
			tenant,
			async () => {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 10_000);
				try {
					const result = await ch().query({
						query: `SELECT * FROM metrics WHERE organization_id = {organization:String} AND project_id = {project:String}${name === undefined ? "" : " AND name = {name:String}"}${cursor ? (cursor.row ? " AND (time_unix_nano, point_id, physical_row_id) < ({time:UInt64}, {id:String}, {row:UUID})" : " AND (time_unix_nano, point_id) < ({time:UInt64}, {id:String})") : ""} ORDER BY time_unix_nano DESC, point_id DESC, physical_row_id DESC LIMIT {limit:UInt32}`,
						query_params: {
							organization: tenant.organizationId,
							project: tenant.projectId,
							name,
							time: cursor?.time,
							id: cursor?.id,
							row: cursor?.row,
							limit: limit + 1,
						},
						format: "JSONEachRow",
						clickhouse_settings: {
							output_format_json_quote_64bit_integers: 1,
							max_execution_time: 10,
							max_result_bytes: "16777216",
							result_overflow_mode: "throw",
						},
						abort_signal: controller.signal,
					});
					const rows = await result.json<StoredMetric>();
					const ids = rows.map((row) => row.physical_row_id);
					if (
						ids.some((id) => !physicalMetricId.test(id)) ||
						new Set(ids).size !== ids.length
					)
						throw new Error(
							"Metric reads require valid, unique page and lookahead UUIDs",
						);
					const items: Omit<StoredMetric, "physical_row_id">[] = [];
					let bytes = 0;
					for (const stored of rows.slice(0, limit)) {
						const { physical_row_id: _physicalRowId, ...row } = stored;
						for (const key of [
							"resource_attributes",
							"scope_attributes",
							"metric_metadata",
							"data_point",
						])
							row[key] = JSON.parse(String(row[key]));
						row.is_monotonic =
							row.is_monotonic === true || row.is_monotonic === 1;
						const size = Buffer.byteLength(JSON.stringify(row));
						if (bytes + size > 250_000) break;
						bytes += size;
						items.push(row);
					}
					if (rows.length && !items.length)
						throw new Error("Metric row exceeds response bound");
					const last = items.at(-1);
					const next_cursor =
						last && rows.length > items.length
							? Buffer.from(
									JSON.stringify({
										organization: tenant.organizationId,
										project: tenant.projectId,
										name: name ?? null,
										time: last.time_unix_nano,
										id: last.point_id,
										row: ids[items.length - 1],
									}),
								).toString("base64url")
							: null;
					return c.json({ items, next_cursor });
				} finally {
					clearTimeout(timeout);
				}
			},
			"product_read",
		);
	} catch (cause) {
		if (cause instanceof TenantScopeError)
			return c.json(
				{ code: "NOT_FOUND", message: "Project is not available" },
				404,
			);
		logger.error("metrics.read_failed", undefined, { project_id: projectId });
		return c.json({ code: "INTERNAL", message: "Metrics read failed" }, 500);
	}
}
