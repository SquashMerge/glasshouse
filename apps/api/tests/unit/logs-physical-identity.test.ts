import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { insertLogs, type ScopedLog } from "../../src/db/logs.js";

const uuidV4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const organizationId = randomUUID();
const projectId = randomUUID();
const duplicate: ScopedLog = {
	log_id: "a".repeat(64),
	organization_id: organizationId,
	project_id: projectId,
	time_unix_nano: "1700000000123456789",
	observed_time_unix_nano: "0",
	ingested_time_unix_nano: "1700000000987654321",
	severity_number: 13,
	severity_text: "WARN",
	trace_id: null,
	span_id: null,
	flags: 0,
	dropped_attributes_count: 0,
	event_name: "",
	body: { stringValue: "identical-body" },
	attributes: [],
	resource: { attributes: [], droppedAttributesCount: 0 },
	scope: { name: "", version: "", attributes: [], droppedAttributesCount: 0 },
	resource_schema_url: "",
	scope_schema_url: "",
};

test("each insertion attempt assigns fresh UUIDv4s per occurrence without changing public IDs or retry tokens", async () => {
	const attempts: Array<{
		values: Array<Record<string, unknown>>;
		clickhouse_settings: Record<string, unknown>;
	}> = [];
	const client = {
		insert: async (request: (typeof attempts)[number]) => {
			attempts.push(request);
		},
	} as unknown as ClickHouseClient;
	const token = "glasshouse:otlp:logs:unchanged-wire-token";
	const original = structuredClone(duplicate);
	await insertLogs(client, [duplicate, duplicate], token);
	await insertLogs(client, [duplicate, duplicate], token);
	expect(duplicate).toEqual(original);
	expect(attempts).toHaveLength(2);
	const ids = attempts.flatMap((attempt) =>
		attempt.values.map((row) => row.physical_row_id),
	);
	for (const id of ids) expect(id).toMatch(uuidV4);
	expect(new Set(ids).size).toBe(4);
	for (const attempt of attempts) {
		expect(attempt.clickhouse_settings).toMatchObject({
			insert_deduplicate: 1,
			insert_deduplication_token: token,
		});
		for (const row of attempt.values) {
			expect(row.log_id).toBe(duplicate.log_id);
			expect(row.body).toBe(JSON.stringify(duplicate.body));
		}
	}
});

test("the writer cannot reuse a physical UUID supplied on a copied input object", async () => {
	const copiedId = randomUUID();
	let rows: Array<Record<string, unknown>> = [];
	const client = {
		insert: async (request: { values: typeof rows }) => {
			rows = request.values;
		},
	} as unknown as ClickHouseClient;
	const copied = { ...duplicate, physical_row_id: copiedId };
	await insertLogs(client, [copied, copied], randomUUID());
	expect(rows).toHaveLength(2);
	for (const row of rows) {
		expect(row.physical_row_id).toMatch(uuidV4);
		expect(row.physical_row_id).not.toBe(copiedId);
	}
	expect(rows[0]!.physical_row_id).not.toBe(rows[1]!.physical_row_id);
	expect(copied.physical_row_id).toBe(copiedId);
});
