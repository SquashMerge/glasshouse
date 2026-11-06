import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate.js";
import {
	insertLogs,
	InvalidLogCursor,
	listLogs,
	logInsertRow,
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

test("log read integrity covers only filtered candidates and excludes other tenants", async () => {
	const projectId = randomUUID();
	const physicalId = randomUUID();
	const visible = row(projectId, "1700000000123456789", "visible-candidate");
	await client.insert({
		table: "logs",
		format: "JSONEachRow",
		values: [
			{ ...logInsertRow(visible), physical_row_id: physicalId },
			{
				...logInsertRow({ ...visible, project_id: randomUUID() }),
				physical_row_id: physicalId,
			},
			{
				...logInsertRow({ ...visible, organization_id: randomUUID() }),
				physical_row_id: physicalId,
			},
		],
	});
	const query = LogListQuery.parse({
		project_id: projectId,
		limit: 1,
		"filter[severity_text]": "WARN",
		"filter[q]": "visible-candidate",
		"filter[time.from]": "2023-11-14T22:13:20Z",
	});
	const page = await listLogs(client, organizationId, query);
	expect(page.items).toHaveLength(1);
	expect(page.total).toBe(1);
	expect(page.items[0]!.body).toEqual({ stringValue: "visible-candidate" });
	expect(page.next_cursor).toBeUndefined();
	await client.insert({
		table: "logs",
		format: "JSONEachRow",
		values: [
			{
				...logInsertRow({
					...row(projectId, "9", "hidden-copy"),
					severity_number: 17,
					severity_text: "ERROR",
				}),
				physical_row_id: physicalId,
			},
		],
	});
	expect(await listLogs(client, organizationId, query)).toEqual(page);
	for (const filters of [
		{ "filter[severity_text]": "WARN" },
		{ "filter[q]": "visible-candidate" },
		{ "filter[time.from]": "2023-11-14T22:13:20Z" },
	])
		expect(
			await listLogs(
				client,
				organizationId,
				LogListQuery.parse({ project_id: projectId, limit: 1, ...filters }),
			),
		).toEqual(page);
	await expect(
		listLogs(
			client,
			organizationId,
			LogListQuery.parse({ project_id: projectId, limit: 2 }),
		),
	).rejects.toThrow("Log reads require valid, unique page and lookahead UUIDs");
});

test("keyset reads do not detect reused UUIDs outside each page plus lookahead", async () => {
	const projectId = randomUUID();
	const physicalId = randomUUID();
	const rows = [
		row(projectId, "4", "newest-copy"),
		row(projectId, "3", "middle-one"),
		row(projectId, "2", "middle-two"),
		row(projectId, "1", "oldest-copy"),
	];
	await client.insert({
		table: "logs",
		format: "JSONEachRow",
		values: rows.map((record, index) => ({
			...logInsertRow(record),
			physical_row_id: index === 0 || index === 3 ? physicalId : randomUUID(),
		})),
	});
	const query = LogListQuery.parse({ project_id: projectId, limit: 1 });
	let cursor: string | undefined;
	for (const [index, expected] of rows.entries()) {
		const page = await listLogs(client, organizationId, { ...query, cursor });
		expect(page.total).toBe(4);
		expect(page.items).toHaveLength(1);
		expect(page.items[0]!.body).toEqual(expected.body);
		cursor = page.next_cursor;
		if (index < rows.length - 1) expect(cursor).toBeDefined();
	}
	expect(cursor).toBeUndefined();
	await expect(
		listLogs(client, organizationId, { ...query, limit: 4 }),
	).rejects.toThrow("Log reads require valid, unique page and lookahead UUIDs");
});

test("same-page and page-lookahead corrupt UUID duplicates fail closed", async () => {
	const projectId = randomUUID();
	const duplicate = {
		...logInsertRow(row(projectId, "1700000000123456789")),
		physical_row_id: randomUUID(),
	};
	await client.insert({
		table: "logs",
		format: "JSONEachRow",
		values: [duplicate, duplicate],
	});
	for (const limit of [1, 2])
		await expect(
			listLogs(
				client,
				organizationId,
				LogListQuery.parse({ project_id: projectId, limit }),
			),
		).rejects.toThrow(
			"Log reads require valid, unique page and lookahead UUIDs",
		);
});

test("filtered log totals include all matching rows across cursors and offsets", async () => {
	const projectId = randomUUID();
	await insertLogs(
		client,
		[
			row(projectId, "9", "matching"),
			row(projectId, "10", "matching"),
			row(projectId, "11", "matching"),
			{ ...row(projectId, "12", "matching"), severity_text: "ERROR" },
			row(projectId, "13", "excluded-body"),
			row(randomUUID(), "14", "matching"),
			{ ...row(projectId, "15", "matching"), organization_id: randomUUID() },
		],
		randomUUID(),
	);
	const query = LogListQuery.parse({
		project_id: projectId,
		limit: 1,
		"filter[severity_text]": "WARN",
		"filter[q]": "matching",
	});
	let cursor: string | undefined;
	for (const time of ["11", "10", "9"]) {
		const page = await listLogs(client, organizationId, { ...query, cursor });
		expect(page.total).toBe(3);
		expect(page.items.map((item) => item.time_unix_nano)).toEqual([time]);
		cursor = page.next_cursor;
		if (time !== "9") expect(cursor).toBeDefined();
	}
	expect(cursor).toBeUndefined();
	const offset = await listLogs(client, organizationId, {
		...query,
		offset: 1,
	});
	expect(offset.total).toBe(3);
	expect(offset.items.map((item) => item.time_unix_nano)).toEqual(["10"]);
	expect(
		await listLogs(client, organizationId, { ...query, offset: 100 }),
	).toEqual({ items: [], total: 3 });
});

test("readable log cursors expose only a scoped UUIDv4 position and reject coordinate-era or non-v4 positions", async () => {
	const projectId = randomUUID();
	const duplicate = row(projectId, "1700000000123456789");
	await insertLogs(client, [duplicate, duplicate], randomUUID());
	const query = LogListQuery.parse({ project_id: projectId, limit: 1 });
	const first = await listLogs(client, organizationId, query);
	expect(first.next_cursor).toBeDefined();
	const cursor = JSON.parse(
		Buffer.from(first.next_cursor!, "base64url").toString("utf8"),
	);
	expect(cursor.version).toBe(3);
	expect(Object.keys(cursor).sort()).toEqual([
		"id",
		"row",
		"scope",
		"time",
		"version",
	]);
	expect(cursor.id).toBe(duplicate.log_id);
	expect(cursor.time).toBe(duplicate.time_unix_nano);
	expect(cursor.row).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	expect(first.items[0]).not.toHaveProperty("physical_row_id");
	for (const stale of [
		{ ...cursor, version: 1 },
		{ ...cursor, version: 2, block: "1", row: "0" },
		{ ...cursor, row: "00000000-0000-0000-0000-000000000000" },
		{ ...cursor, row: "018f05c9-4ab8-7b86-b64e-c9f03fbd45d1" },
	])
		await expect(
			listLogs(client, organizationId, {
				...query,
				cursor: Buffer.from(JSON.stringify(stale)).toString("base64url"),
			}),
		).rejects.toBeInstanceOf(InvalidLogCursor);
});

test("fresh physical UUIDs do not defeat token deduplication and remain stored across part rewrites", async () => {
	const projectId = randomUUID();
	const duplicate = row(projectId, "1700000000123456789");
	const token = randomUUID();
	const snapshot = async () => {
		const result = await client.query({
			query:
				"SELECT log_id, toString(physical_row_id) AS physical_row_id FROM logs WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} ORDER BY physical_row_id",
			query_params: { organizationId, projectId },
			format: "JSONEachRow",
		});
		return result.json<{ log_id: string; physical_row_id: string }>();
	};
	await insertLogs(client, [duplicate, duplicate], token);
	const before = await snapshot();
	expect(before).toHaveLength(2);
	for (const stored of before)
		expect(stored.physical_row_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	expect(new Set(before.map((stored) => stored.physical_row_id)).size).toBe(2);
	await insertLogs(client, [duplicate, duplicate], token);
	expect(await snapshot()).toEqual(before);
	await insertLogs(client, [duplicate, duplicate], randomUUID());
	const insertedAgain = await snapshot();
	expect(insertedAgain).toHaveLength(4);
	expect(
		new Set(insertedAgain.map((stored) => stored.physical_row_id)).size,
	).toBe(4);
	expect(new Set(insertedAgain.map((stored) => stored.log_id))).toEqual(
		new Set([duplicate.log_id]),
	);
	const query = LogListQuery.parse({ project_id: projectId, limit: 1 });
	const visited: string[] = [];
	let cursor: string | undefined;
	for (let index = 0; index < 4; index++) {
		const page = await listLogs(client, organizationId, { ...query, cursor });
		expect(page.items).toHaveLength(1);
		expect(page.total).toBe(4);
		cursor = page.next_cursor;
		if (cursor) {
			const position = JSON.parse(Buffer.from(cursor, "base64url").toString());
			expect(position.version).toBe(3);
			expect(position).not.toHaveProperty("block");
			expect(position.row).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			visited.push(position.row);
		}
		await client.command({
			query:
				"OPTIMIZE TABLE logs FINAL SETTINGS optimize_skip_merged_partitions = 0",
		});
		await client.command({
			query:
				"ALTER TABLE logs UPDATE event_name = 'physical-identity-rewrite' WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} SETTINGS mutations_sync = 1",
			query_params: { organizationId, projectId },
		});
		expect(await snapshot()).toEqual(insertedAgain);
	}
	expect(cursor).toBeUndefined();
	expect(new Set(visited).size).toBe(3);
	const deletedId = insertedAgain[0]!.physical_row_id;
	await client.command({
		query:
			"ALTER TABLE logs DELETE WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} AND physical_row_id = {deletedId:UUID} SETTINGS mutations_sync = 1",
		query_params: { organizationId, projectId, deletedId },
	});
	await client.command({
		query:
			"OPTIMIZE TABLE logs FINAL SETTINGS optimize_skip_merged_partitions = 0",
	});
	expect(await snapshot()).toEqual(
		insertedAgain.filter((stored) => stored.physical_row_id !== deletedId),
	);
});

test("an administrative scoped physical restore preserves UUIDs without importing another tenant", async () => {
	const projectId = randomUUID();
	const otherProjectId = randomUUID();
	const duplicate = row(projectId, "1700000000123456789");
	await insertLogs(
		client,
		[duplicate, duplicate, row(otherProjectId, "9")],
		randomUUID(),
	);
	await insertLogs(
		client,
		[{ ...row(projectId, "10"), organization_id: randomUUID() }],
		randomUUID(),
	);
	const selected = await client.query({
		query:
			"SELECT * FROM logs WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} ORDER BY physical_row_id",
		query_params: { organizationId, projectId },
		format: "JSONEachRow",
	});
	const original = await selected.json<Record<string, unknown>>();
	expect(original).toHaveLength(2);
	expect(new Set(original.map((stored) => stored.physical_row_id)).size).toBe(
		2,
	);
	let restoreCreated = false;
	try {
		await client.command({ query: "CREATE TABLE logs_scoped_restore AS logs" });
		restoreCreated = true;
		await client.command({
			query:
				"INSERT INTO logs_scoped_restore SELECT * FROM logs WHERE organization_id = {organizationId:String} AND project_id = {projectId:String}",
			query_params: { organizationId, projectId },
		});
		await client.command({ query: "OPTIMIZE TABLE logs_scoped_restore FINAL" });
		const restored = await client.query({
			query: "SELECT * FROM logs_scoped_restore ORDER BY physical_row_id",
			format: "JSONEachRow",
		});
		expect(await restored.json()).toEqual(original);
	} finally {
		if (restoreCreated)
			await client.command({ query: "DROP TABLE logs_scoped_restore SYNC" });
	}
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
						physical_row_id: randomUUID(),
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
