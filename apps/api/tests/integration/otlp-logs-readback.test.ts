import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

test("two identical physical log rows remain reachable with limit one", async () => {
	const projectId = randomUUID();
	const duplicate = row(projectId, "1700000000123456789");
	await insertLogs(client, [duplicate, duplicate], randomUUID());
	const query = LogListQuery.parse({ project_id: projectId, limit: 1 });
	const first = await listLogs(client, organizationId, query);
	expect(first.total).toBe(2);
	expect(first.items).toHaveLength(1);
	expect(first.next_cursor).toBeDefined();
	const second = await listLogs(client, organizationId, {
		...query,
		cursor: first.next_cursor,
	});
	expect(second.total).toBe(2);
	expect(second.items).toHaveLength(1);
	expect(second.items[0]).toEqual(first.items[0]);
	expect(second.next_cursor).toBeUndefined();
});

test("limit-one log keysets return physical duplicates across merges without collapsing independent payloads", async () => {
	const projectId = randomUUID();
	const duplicate = row(projectId, "1700000000123456789", "duplicate-body");
	const independent = row(
		projectId,
		duplicate.time_unix_nano,
		"duplicate-body",
	);
	const changed = {
		...duplicate,
		body: { stringValue: "independent-payload" },
	};
	await insertLogs(
		client,
		[duplicate, duplicate, independent, changed],
		randomUUID(),
	);
	const query = LogListQuery.parse({ project_id: projectId, limit: 1 });
	const items = [];
	let cursor: string | undefined;
	for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
		const page = await listLogs(client, organizationId, { ...query, cursor });
		expect(page.total).toBe(4);
		expect(page.items).toHaveLength(1);
		items.push(...page.items);
		cursor = page.next_cursor;
		if (pageNumber < 3) expect(cursor).toBeDefined();
		await client.command({ query: "OPTIMIZE TABLE logs FINAL" });
	}
	expect(cursor).toBeUndefined();
	expect(items.filter((item) => item.log_id === duplicate.log_id)).toHaveLength(
		3,
	);
	expect(
		items.filter((item) => item.body.stringValue === "duplicate-body"),
	).toHaveLength(3);
	expect(
		items.filter((item) => item.body.stringValue === "independent-payload"),
	).toHaveLength(1);
});

test("the physical-row migration preserves populated legacy parts and their coordinates across merges and mutations", async () => {
	const original = readFileSync(
		new URL(
			"../../../../infra/db/clickhouse/0009_otlp_logs.sql",
			import.meta.url,
		),
		"utf8",
	);
	const migration = readFileSync(
		new URL(
			"../../../../infra/db/clickhouse/0011_logs_physical_row_identity.sql",
			import.meta.url,
		),
		"utf8",
	);
	await client.command({
		query: original.replace("IF NOT EXISTS logs", "IF NOT EXISTS logs_upgrade"),
	});
	try {
		for (let batch = 0; batch < 2; batch++)
			await client.command({
				query: `INSERT INTO logs_upgrade (log_id, organization_id, project_id, ingested_time_unix_nano, body) SELECT 'same-id', 'legacy-org', 'legacy-project', 1700000000000000000, '{"stringValue":"legacy-body"}' FROM numbers(3)`,
			});
		await client.command({ query: "OPTIMIZE TABLE logs_upgrade FINAL" });
		for (let attempt = 0; attempt < 2; attempt++)
			await client.command({
				query: migration.replace(
					"ALTER TABLE logs",
					"ALTER TABLE logs_upgrade",
				),
			});
		const snapshot = async () => {
			const result = await client.query({
				query:
					"SELECT *, toString(_block_number) AS block, toString(_block_offset) AS position FROM logs_upgrade ORDER BY block, position",
				format: "JSONEachRow",
			});
			return result.json<Record<string, unknown>>();
		};
		const before = await snapshot();
		expect(before).toHaveLength(6);
		expect(
			new Set(before.map((row) => `${row.block}:${row.position}`)).size,
		).toBe(6);
		await client.command({ query: "OPTIMIZE TABLE logs_upgrade FINAL" });
		expect(await snapshot()).toEqual(before);
		const selected = before[0]!;
		await client.command({
			query:
				"ALTER TABLE logs_upgrade DELETE WHERE _block_number = {block:UInt64} AND _block_offset = {position:UInt64} SETTINGS mutations_sync = 1",
			query_params: { block: selected.block, position: selected.position },
		});
		await client.command({ query: "OPTIMIZE TABLE logs_upgrade FINAL" });
		expect(await snapshot()).toEqual(before.slice(1));
	} finally {
		await client.command({ query: "DROP TABLE logs_upgrade SYNC" });
	}
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
