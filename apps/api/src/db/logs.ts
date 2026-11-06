import type { ClickHouseClient } from "@clickhouse/client";
import type { z } from "@hono/zod-openapi";
import type { LogListQuery, LogRecord } from "../schemas/logs.js";
import { LogNano } from "../schemas/logs.js";
import { createHash } from "node:crypto";
import { ch, CLICKHOUSE_REQUEST_TIMEOUT_MS } from "./clickhouse.js";
import { insertWithDeadline } from "./traces-writer.js";

export type ScopedLog = Omit<LogRecord, "effective_time_unix_nano"> & {
	organization_id: string;
};
export const MAX_LOG_RECORD_BYTES = 65_536;
export const MAX_LOG_RESPONSE_BYTES = 262_144;

export async function insertLogs(
	client: ClickHouseClient,
	logs: ScopedLog[],
	token: string,
): Promise<void> {
	if (!logs.length) return;
	await insertWithDeadline(
		client,
		{
			table: "logs",
			format: "JSONEachRow",
			values: logs.map((log) => ({
				...log,
				body: JSON.stringify(log.body),
				attributes: JSON.stringify(log.attributes),
				resource: JSON.stringify(log.resource),
				scope: JSON.stringify(log.scope),
			})),
			clickhouse_settings: {
				insert_deduplicate: 1,
				insert_deduplication_token: token,
			},
		},
		CLICKHOUSE_REQUEST_TIMEOUT_MS,
	);
}

type StoredLog = Omit<
	LogRecord,
	"body" | "attributes" | "resource" | "scope"
> & {
	body: string;
	attributes: string;
	resource: string;
	scope: string;
};
const columns =
	"log_id, project_id, time_unix_nano, observed_time_unix_nano, ingested_time_unix_nano, effective_time_unix_nano, severity_number, severity_text, trace_id, span_id, flags, dropped_attributes_count, event_name, body, attributes, resource, scope, resource_schema_url, scope_schema_url";
export class InvalidLogCursor extends Error {}

export async function deleteLogRetentionBatch(
	organizationId: string,
	projectId: string,
	cutoff: Date,
	batchSize: number,
): Promise<number> {
	const client = ch();
	const params = {
		organizationId,
		projectId,
		cutoff: (BigInt(cutoff.getTime()) * 1_000_000n).toString(),
		batchSize,
	};
	const result = await client.query({
		query:
			"WITH grouped AS (SELECT log_id, min(effective_time_unix_nano) AS oldest, max(effective_time_unix_nano) AS newest, count() AS physical_rows FROM logs WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} GROUP BY log_id HAVING newest < {cutoff:UInt64} AND physical_rows <= {batchSize:UInt64}), bounded AS (SELECT log_id, physical_rows, oldest, sum(physical_rows) OVER (ORDER BY oldest, log_id) AS cumulative_rows FROM grouped) SELECT log_id, physical_rows FROM bounded WHERE cumulative_rows <= {batchSize:UInt64} ORDER BY oldest, log_id",
		query_params: params,
		format: "JSONEachRow",
		clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
	});
	const selected = await result.json<{
		log_id: string;
		physical_rows: string;
	}>();
	if (!selected.length) return 0;
	await client.command({
		query:
			"ALTER TABLE logs DELETE WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} AND log_id IN {ids:Array(String)} AND effective_time_unix_nano < {cutoff:UInt64} SETTINGS mutations_sync = 1",
		query_params: { ...params, ids: selected.map((row) => row.log_id) },
	});
	return selected.reduce((total, row) => total + Number(row.physical_rows), 0);
}

export async function listLogs(
	client: ClickHouseClient,
	organizationId: string,
	query: z.infer<typeof LogListQuery>,
) {
	const where = [
		"organization_id = {organizationId:String}",
		"project_id = {projectId:String}",
	];
	const params: Record<string, string | number> = {
		organizationId,
		projectId: query.project_id,
		limit: query.limit + 1,
		offset: query.offset,
	};
	for (const key of ["severity_number", "severity_text", "trace_id"] as const) {
		const value = query[`filter[${key}]`];
		if (value === undefined) continue;
		where.push(
			`${key} = {${key}:${key === "severity_number" ? "UInt8" : "String"}}`,
		);
		params[key] = key === "trace_id" ? String(value).toLowerCase() : value;
	}
	if (query["filter[q]"]) {
		where.push("positionCaseInsensitiveUTF8(body, {search:String}) > 0");
		params.search = query["filter[q]"];
	}
	for (const [key, operator] of [
		["from", ">="],
		["to", "<="],
	] as const) {
		const value = query[`filter[time.${key}]`];
		if (!value) continue;
		const nano = logFilterNano(value);
		params[key] = nano.toString();
		where.push(`effective_time_unix_nano ${operator} {${key}:UInt64}`);
	}
	const predicate = where.join(" AND ");
	const scope = createHash("sha256")
		.update(
			JSON.stringify({
				organizationId,
				...query,
				limit: undefined,
				offset: undefined,
				cursor: undefined,
			}),
		)
		.digest("hex");
	let continuation = "";
	if (query.cursor) {
		try {
			const cursor = JSON.parse(
				Buffer.from(query.cursor, "base64url").toString("utf8"),
			);
			if (
				cursor.scope !== scope ||
				!LogNano.safeParse(cursor.time).success ||
				typeof cursor.id !== "string" ||
				!/^[a-f0-9]{64}$/.test(cursor.id)
			)
				throw new InvalidLogCursor();
			params.cursorTime = cursor.time;
			params.cursorId = cursor.id;
			continuation =
				" AND (effective_time_unix_nano, log_id) < ({cursorTime:UInt64}, {cursorId:String})";
		} catch {
			throw new InvalidLogCursor();
		}
	}
	const result = await client.query({
		query: `SELECT ${columns} FROM logs WHERE ${predicate}${continuation} ORDER BY effective_time_unix_nano DESC, log_id DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
		query_params: params,
		format: "JSONEachRow",
		clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
	});
	const rows = await result.json<StoredLog>();
	const count = await client.query({
		query: `SELECT count() AS total FROM logs WHERE ${predicate}`,
		query_params: params,
		format: "JSONEachRow",
	});
	const total = Number((await count.json<{ total: string }>())[0]?.total ?? 0);
	const items: LogRecord[] = [];
	let bytes = 1024;
	for (const row of rows.slice(0, query.limit)) {
		const item: LogRecord = {
			...row,
			body: JSON.parse(row.body),
			attributes: JSON.parse(row.attributes),
			resource: JSON.parse(row.resource),
			scope: JSON.parse(row.scope),
		};
		const size = Buffer.byteLength(JSON.stringify(item)) + 1;
		if (bytes + size > MAX_LOG_RESPONSE_BYTES) break;
		items.push(item);
		bytes += size;
	}
	if (rows.length && !items.length)
		throw new Error("Stored log exceeds response budget");
	const last = items.at(-1);
	return {
		items,
		total,
		...(items.length < Math.min(rows.length, query.limit)
			? { response_truncated: true }
			: {}),
		...(last && rows.length > items.length
			? {
					next_cursor: Buffer.from(
						JSON.stringify({
							scope,
							time: last.effective_time_unix_nano,
							id: last.log_id,
						}),
					).toString("base64url"),
				}
			: {}),
	};
}

export function logFilterNano(value: string): bigint {
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(
		value,
	);
	if (!match) throw new InvalidLogCursor();
	const milliseconds = new Date(`${match[1]}Z`).getTime();
	if (!Number.isFinite(milliseconds)) throw new InvalidLogCursor();
	const nano =
		BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
	if (nano < 0n || nano > 18_446_744_073_709_551_615n)
		throw new InvalidLogCursor();
	return nano;
}
