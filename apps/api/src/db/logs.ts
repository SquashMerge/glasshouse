import type { ClickHouseClient } from "@clickhouse/client";
import type { z } from "@hono/zod-openapi";
import type { LogListQuery, LogRecord } from "../schemas/logs.js";
import { LogNano } from "../schemas/logs.js";
import { createHash, randomUUID } from "node:crypto";
import { ch, CLICKHOUSE_REQUEST_TIMEOUT_MS } from "./clickhouse.js";
import { insertWithDeadline } from "./traces-writer.js";

export type ScopedLog = Omit<LogRecord, "effective_time_unix_nano"> & {
	organization_id: string;
};
export const MAX_LOG_RECORD_BYTES = 65_536;
export const MAX_LOG_EXPORT_BYTES = 4 * 1024 * 1024;
export const MAX_LOG_RESPONSE_BYTES = 262_144;
export const LOG_PHYSICAL_ID_BYTES = Buffer.byteLength(
	',"physical_row_id":"00000000-0000-4000-8000-000000000000"',
);

export function logInsertRow(log: ScopedLog) {
	return {
		...log,
		body: JSON.stringify(log.body),
		attributes: JSON.stringify(log.attributes),
		resource: JSON.stringify(log.resource),
		scope: JSON.stringify(log.scope),
	};
}

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
				...logInsertRow(log),
				physical_row_id: randomUUID(),
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
	physical_row_id: string;
};
const physicalRowId =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const columns =
	"log_id, project_id, time_unix_nano, observed_time_unix_nano, ingested_time_unix_nano, effective_time_unix_nano, severity_number, severity_text, trace_id, span_id, flags, dropped_attributes_count, event_name, body, attributes, resource, scope, resource_schema_url, scope_schema_url, physical_row_id";
export class InvalidLogCursor extends Error {}

export async function deleteLogRetentionBatch(
	organizationId: string,
	projectId: string,
	cutoff: Date,
	batchSize: number,
): Promise<number> {
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500)
		throw new RangeError("Invalid log retention batch size");
	const client = ch();
	const params = {
		organizationId,
		projectId,
		cutoff: (BigInt(cutoff.getTime()) * 1_000_000n).toString(),
		batchSize,
	};
	const result = await client.query({
		query:
			"SELECT physical_row_id FROM logs WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} AND effective_time_unix_nano < {cutoff:UInt64} ORDER BY effective_time_unix_nano, log_id, physical_row_id LIMIT {batchSize:UInt32}",
		query_params: params,
		format: "JSONEachRow",
		clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
	});
	const selected = await result.json<{ physical_row_id: string }>();
	if (!selected.length) return 0;
	const ids = selected.map((row) => row.physical_row_id);
	if (
		selected.length > batchSize ||
		ids.some((id) => !physicalRowId.test(id)) ||
		new Set(ids).size !== selected.length
	)
		throw new Error("Invalid physical log identity in retention selection");
	const selectedParams = {
		...params,
		ids,
	};
	const identityPredicate =
		"organization_id = {organizationId:String} AND project_id = {projectId:String} AND physical_row_id IN {ids:Array(UUID)}";
	// Include nonexpired copies too: an administrative duplicate must never widen
	// a bounded physical-row selection into a larger deletion.
	const identity = await client.query({
		query: `SELECT count() AS total, uniqExact(physical_row_id) AS distinct_ids FROM logs WHERE ${identityPredicate}`,
		query_params: selectedParams,
		format: "JSONEachRow",
	});
	const [verified] = await identity.json<{
		total: string;
		distinct_ids: string;
	}>();
	if (
		Number(verified?.total) !== selected.length ||
		Number(verified?.distinct_ids) !== selected.length
	)
		throw new Error("Log retention requires unique scoped physical UUIDs");
	const predicate = `${identityPredicate} AND effective_time_unix_nano < {cutoff:UInt64}`;
	await client.command({
		query: `ALTER TABLE logs DELETE WHERE ${predicate} SETTINGS mutations_sync = 1`,
		query_params: selectedParams,
	});
	const remaining = await client.query({
		query: `SELECT count() AS total FROM logs WHERE ${predicate}`,
		query_params: selectedParams,
		format: "JSONEachRow",
	});
	if (Number((await remaining.json<{ total: string }>())[0]?.total) !== 0)
		throw new Error("Log retention did not remove the selected rows");
	return selected.length;
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
				cursor.version !== 3 ||
				Object.keys(cursor).sort().join(",") !== "id,row,scope,time,version" ||
				cursor.scope !== scope ||
				!LogNano.safeParse(cursor.time).success ||
				typeof cursor.row !== "string" ||
				!physicalRowId.test(cursor.row) ||
				typeof cursor.id !== "string" ||
				!/^[a-f0-9]{64}$/.test(cursor.id)
			)
				throw new InvalidLogCursor();
			params.cursorTime = cursor.time;
			params.cursorId = cursor.id;
			params.cursorRow = cursor.row;
			continuation =
				" AND (effective_time_unix_nano, log_id, physical_row_id) < ({cursorTime:UInt64}, {cursorId:String}, {cursorRow:UUID})";
		} catch {
			throw new InvalidLogCursor();
		}
	}
	const result = await client.query({
		query: `SELECT ${columns} FROM logs WHERE ${predicate}${continuation} ORDER BY effective_time_unix_nano DESC, log_id DESC, physical_row_id DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
		query_params: params,
		format: "JSONEachRow",
		clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
	});
	const rows = await result.json<StoredLog>();
	if (rows.length) {
		const ids = rows.map((row) => row.physical_row_id);
		if (
			ids.some((id) => !physicalRowId.test(id)) ||
			new Set(ids).size !== rows.length
		)
			throw new Error(
				"Log reads require valid, unique page and lookahead UUIDs",
			);
	}
	const count = await client.query({
		query: `SELECT count() AS total FROM logs WHERE ${predicate}`,
		query_params: params,
		format: "JSONEachRow",
	});
	const total = Number((await count.json<{ total: string }>())[0]?.total ?? 0);
	const items: LogRecord[] = [];
	let bytes = 1024;
	for (const row of rows.slice(0, query.limit)) {
		const { physical_row_id: _physicalId, ...publicRow } = row;
		const item: LogRecord = {
			...publicRow,
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
	const last = rows[items.length - 1];
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
							version: 3,
							scope,
							time: last.effective_time_unix_nano,
							id: last.log_id,
							row: last.physical_row_id,
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
