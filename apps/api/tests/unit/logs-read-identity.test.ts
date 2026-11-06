import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import { listLogs } from "../../src/db/logs.js";
import { LogListQuery } from "../../src/schemas/logs.js";

const organizationId = randomUUID();
const projectId = randomUUID();
const query = LogListQuery.parse({ project_id: projectId, limit: 1 });

function row() {
	return {
		log_id: "a".repeat(64),
		project_id: projectId,
		physical_row_id: randomUUID(),
		time_unix_nano: "1700000000123456789",
		observed_time_unix_nano: "0",
		ingested_time_unix_nano: "1700000000987654321",
		effective_time_unix_nano: "1700000000123456789",
		severity_number: 13,
		severity_text: "WARN",
		trace_id: null,
		span_id: null,
		flags: 0,
		dropped_attributes_count: 0,
		event_name: "",
		body: '{"stringValue":"read identity"}',
		attributes: "[]",
		resource: '{"attributes":[],"droppedAttributesCount":0}',
		scope:
			'{"name":"","version":"","attributes":[],"droppedAttributesCount":0}',
		resource_schema_url: "",
		scope_schema_url: "",
	};
}

type Request = { query: string; query_params: Record<string, unknown> };
function reader(rows: ReturnType<typeof row>[], total = rows.length) {
	const requests: Request[] = [];
	const client = {
		query: async (request: Request) => {
			requests.push(request);
			if (request.query.startsWith("SELECT log_id, project_id,"))
				return { json: async () => rows };
			if (request.query.startsWith("SELECT count() AS total FROM logs WHERE"))
				return { json: async () => [{ total: String(total) }] };
			throw new Error("Unexpected log query: " + request.query);
		},
	} as unknown as ClickHouseClient;
	return { client, requests };
}

for (const limit of [1, 200]) {
	test(`log reads validate ${limit + 1} page-plus-lookahead UUIDs with only a page query and exact count`, async () => {
		const rows = Array.from({ length: limit + 1 }, row);
		const { client, requests } = reader(rows);
		const result = await listLogs(client, organizationId, { ...query, limit });
		expect(result.items).toHaveLength(limit);
		expect(result.total).toBe(rows.length);
		for (const item of result.items) {
			expect(item.body).toEqual({ stringValue: "read identity" });
			expect(item).not.toHaveProperty("physical_row_id");
		}
		const cursor = JSON.parse(
			Buffer.from(result.next_cursor!, "base64url").toString("utf8"),
		);
		expect(cursor.row).toBe(rows[limit - 1]!.physical_row_id);
		expect(requests).toHaveLength(2);
		expect(requests[0]!.query).toContain("LIMIT {limit:UInt32}");
		expect(requests[0]!.query_params.limit).toBe(limit + 1);
		expect(requests[1]!.query).toBe(
			"SELECT count() AS total FROM logs WHERE organization_id = {organizationId:String} AND project_id = {projectId:String}",
		);
		for (const request of requests) {
			expect(request.query_params).toMatchObject({ organizationId, projectId });
			expect(request.query).not.toContain("uniqExact");
			expect(request.query).not.toContain("physical_row_id IN");
		}
	});
}

test("empty log pages do not perform a Project UUID integrity scan", async () => {
	const { client, requests } = reader([]);
	expect(await listLogs(client, organizationId, query)).toEqual({
		items: [],
		total: 0,
	});
	expect(requests).toHaveLength(2);
	expect(requests[0]!.query).toStartWith("SELECT log_id, project_id,");
	expect(requests[1]!.query).toStartWith("SELECT count() AS total FROM logs");
});

for (const invalid of [
	"00000000-0000-0000-0000-000000000000",
	"018f05c9-4ab8-7b86-b64e-c9f03fbd45d1",
	"not-a-uuid",
]) {
	for (const index of [0, 1]) {
		test(`log reads reject invalid ${index === 0 ? "page" : "lookahead"} identity ${invalid} before exposing a cursor`, async () => {
			const rows = [row(), row()];
			rows[index]!.physical_row_id = invalid;
			const { client, requests } = reader(rows);
			await expect(listLogs(client, organizationId, query)).rejects.toThrow(
				"Log reads require valid, unique page and lookahead UUIDs",
			);
			expect(requests).toHaveLength(1);
		});
	}
}

for (const limit of [1, 2]) {
	test(`duplicate UUIDs ${limit === 1 ? "across page and lookahead" : "within the page"} fail before any cursor is exposed`, async () => {
		const duplicate = row();
		const { client, requests } = reader([duplicate, duplicate]);
		await expect(
			listLogs(client, organizationId, { ...query, limit }),
		).rejects.toThrow(
			"Log reads require valid, unique page and lookahead UUIDs",
		);
		expect(requests).toHaveLength(1);
	});
}

test("filtered totals count matching history independently of the cursor or fetched UUIDs", async () => {
	const filtered = { ...query, "filter[severity_text]": "WARN" };
	const first = reader([row(), row()], 17);
	const page = await listLogs(first.client, organizationId, filtered);
	expect(page.total).toBe(17);
	expect(page.next_cursor).toBeDefined();
	const next = reader([row()], 17);
	const continuation = await listLogs(next.client, organizationId, {
		...filtered,
		cursor: page.next_cursor,
	});
	expect(continuation.total).toBe(17);
	expect(next.requests).toHaveLength(2);
	expect(next.requests[0]!.query).toContain("{cursorRow:UUID}");
	expect(next.requests[1]!.query).toBe(
		"SELECT count() AS total FROM logs WHERE organization_id = {organizationId:String} AND project_id = {projectId:String} AND severity_text = {severity_text:String}",
	);
});
