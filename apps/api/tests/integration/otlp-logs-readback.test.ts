import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate.js";
import {
	insertLogs,
	InvalidLogCursor,
	listLogs,
	MAX_LOG_RESPONSE_BYTES,
	type ScopedLog,
} from "../../src/db/logs.js";
import { LogListQuery } from "../../src/schemas/logs.js";
import { otlpDisposableDatastores } from "../helpers/otlp-disposable-datastores.js";

const database = `otlp_extension_${randomUUID().replaceAll("-", "")}`;
const organizationId = randomUUID();
let admin: ClickHouseClient;
let client: ClickHouseClient;
let created = false;

beforeAll(async () => {
	const config = otlpDisposableDatastores(process.env, database);
	admin = createClient(config.clickhouseAdminOptions);
	await admin.command({ query: `CREATE DATABASE ${database}` });
	created = true;
	client = createClient(config.clickhouseOptions);
	const selected = await client.query({
		query: "SELECT currentDatabase() AS name",
		format: "JSONEachRow",
	});
	expect((await selected.json<{ name: string }>())[0]?.name).toBe(database);
	await applyClickHouseMigrations(
		createClient(config.clickhouseOptions),
		async (run) => run(),
	);
}, 30_000);

afterAll(async () => {
	try {
		await client?.close();
		if (created)
			await admin.command({ query: `DROP DATABASE ${database} SYNC` });
	} finally {
		await admin?.close();
	}
});

function row(projectId: string, time: string, body = "readback"): ScopedLog {
	return {
		log_id: randomUUID().replaceAll("-", "").repeat(2),
		organization_id: organizationId,
		project_id: projectId,
		time_unix_nano: time,
		observed_time_unix_nano: "0",
		ingested_time_unix_nano: "1700000000000000000",
		severity_number: 13,
		severity_text: "WARN",
		trace_id: null,
		span_id: null,
		flags: 0,
		dropped_attributes_count: 0,
		event_name: "",
		body: { stringValue: body },
		attributes: [],
		resource: { attributes: [], droppedAttributesCount: 0 },
		scope: {
			name: "readback",
			version: "1",
			attributes: [],
			droppedAttributesCount: 0,
		},
		resource_schema_url: "",
		scope_schema_url: "",
	};
}

test("log keysets sort UInt64 numerically across decimal widths and reject scope/filter reuse", async () => {
	const projectId = randomUUID();
	await insertLogs(
		client,
		[
			row(projectId, "9"),
			row(projectId, "10"),
			row(projectId, "18446744073709551615"),
		],
		randomUUID(),
	);
	const query = LogListQuery.parse({ project_id: projectId, limit: 2 });
	const first = await listLogs(client, organizationId, query);
	expect(first.items.map((item) => item.time_unix_nano)).toEqual([
		"18446744073709551615",
		"10",
	]);
	expect(first.next_cursor).toBeDefined();
	const last = await listLogs(client, organizationId, {
		...query,
		cursor: first.next_cursor,
	});
	expect(last.items.map((item) => item.time_unix_nano)).toEqual(["9"]);
	expect(last.next_cursor).toBeUndefined();
	for (const changed of [
		{ ...query, project_id: randomUUID() },
		{ ...query, "filter[severity_text]": "ERROR" },
	]) {
		await expect(
			listLogs(client, organizationId, {
				...changed,
				cursor: first.next_cursor,
			}),
		).rejects.toBeInstanceOf(InvalidLogCursor);
	}
	await expect(
		listLogs(client, randomUUID(), { ...query, cursor: first.next_cursor }),
	).rejects.toBeInstanceOf(InvalidLogCursor);
});

test("typed log pages honor their UTF-8 budget and continue without losing retained bodies", async () => {
	const projectId = randomUUID();
	const body = "界".repeat(15_000);
	await insertLogs(
		client,
		Array.from({ length: 6 }, (_, index) =>
			row(projectId, String(index + 1), body),
		),
		randomUUID(),
	);
	const query = LogListQuery.parse({ project_id: projectId, limit: 200 });
	const first = await listLogs(client, organizationId, query);
	expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
		MAX_LOG_RESPONSE_BYTES,
	);
	expect(first.response_truncated).toBe(true);
	expect(first.next_cursor).toBeDefined();
	const next = await listLogs(client, organizationId, {
		...query,
		cursor: first.next_cursor,
	});
	const combined = [...first.items, ...next.items];
	expect(combined).toHaveLength(6);
	expect(new Set(combined.map((item) => item.log_id)).size).toBe(6);
	for (const item of combined) expect(item.body.stringValue).toBe(body);
});

test("ClickHouse rejects physically unscoped logs", async () => {
	for (const missing of ["organization_id", "project_id"] as const) {
		await expect(
			client.insert({
				table: "logs",
				format: "JSONEachRow",
				values: [
					{
						log_id: randomUUID(),
						organization_id: organizationId,
						project_id: randomUUID(),
						ingested_time_unix_nano: "1700000000000000000",
						[missing]: "",
					},
				],
			}),
		).rejects.toThrow(/logs_tenant_scope/);
	}
});
