import { describe, expect, it } from "bun:test";
import {
	getTrace,
	listObservations,
	listTraces,
} from "../../src/db/traces-query";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function fakeClient() {
	const queries: Array<{
		query: string;
		query_params: Record<string, unknown>;
	}> = [];
	let firstQuery = true;
	return {
		client: {
			query: async (request: {
				query: string;
				query_params: Record<string, unknown>;
			}) => {
				queries.push(request);
				const rows = firstQuery ? [{}] : [];
				firstQuery = false;
				return { json: async () => rows };
			},
		},
		queries,
	};
}

describe("getTrace project scope", () => {
	it("filters both trace and observations by the selected project", async () => {
		const { client, queries } = fakeClient();
		const controller = new AbortController();
		await getTrace(
			client as never,
			ORGANIZATION_ID,
			TRACE_ID,
			PROJECT_ID,
			controller.signal,
		);

		expect(queries).toHaveLength(2);
		expect(queries[0]).toMatchObject({
			query: expect.stringContaining("project_id = {project_id: String}"),
			query_params: {
				organization_id: ORGANIZATION_ID,
				trace_id: TRACE_ID,
				project_id: PROJECT_ID,
			},
		});
		expect(queries[1]!.query).toContain(
			"ORDER BY start_time ASC, observation_id ASC",
		);
		expect(queries[1]!.query).toContain(
			"model, if(length(observations.input_text) > 8192, substringUTF8(observations.input_text, 1, 2048), observations.input_text) AS input_text",
		);
		expect(queries[1]!.query).toContain("metadata_truncated");
		expect(queries[1]).toMatchObject({
			query: expect.stringContaining("LIMIT {limit: UInt32}"),
			query_params: {
				organization_id: ORGANIZATION_ID,
				trace_id: TRACE_ID,
				project_id: PROJECT_ID,
				limit: 8,
			},
		});
		for (const request of queries)
			expect(request).toMatchObject({ abort_signal: controller.signal });
	});

	it("limits omitted project scope to legacy unscoped rows", async () => {
		const { client, queries } = fakeClient();
		await getTrace(client as never, ORGANIZATION_ID, TRACE_ID);

		expect(queries[0]).toMatchObject({
			query: expect.stringContaining("project_id = {project_id: String}"),
			query_params: {
				organization_id: ORGANIZATION_ID,
				trace_id: TRACE_ID,
				project_id: "",
			},
		});
	});
});

describe("listTraces empty result", () => {
	it("projects both text directions and metadata to bounded list fields", async () => {
		const { client, queries } = fakeClient();
		await listTraces(
			client as never,
			{ organization_id: ORGANIZATION_ID, project_id: PROJECT_ID },
			50,
			undefined,
		);
		await listObservations(
			client as never,
			{ organization_id: ORGANIZATION_ID, project_id: PROJECT_ID },
			50,
			undefined,
		);

		expect(queries[0]?.query).toContain("substringUTF8(input_text, 1, 200)");
		expect(queries[0]?.query).toContain("substringUTF8(output_text, 1, 200)");
		expect(queries[2]?.query).toContain("substringUTF8(input_text, 1, 200)");
		expect(queries[2]?.query).toContain("substringUTF8(output_text, 1, 200)");
		expect(queries[2]?.query).toContain("metadata_truncated");
	});

	it("projects storage-bounded detail fields and marks legacy oversize text", async () => {
		const { client, queries } = fakeClient();
		await getTrace(client as never, ORGANIZATION_ID, TRACE_ID, PROJECT_ID);

		const detailQuery = queries[1]!.query;
		expect(detailQuery).toContain(
			"model, if(length(observations.input_text) > 8192, substringUTF8(observations.input_text, 1, 2048), observations.input_text) AS input_text",
		);
		expect(detailQuery).toContain("length(observations.input_text) > 8192");
		expect(detailQuery).toContain("input_retained_truncated");
		expect(detailQuery).toContain("output_retained_truncated");
	});

	it("query-bounds legacy detail text before it can be materialized", async () => {
		const { client, queries } = fakeClient();
		await getTrace(client as never, ORGANIZATION_ID, TRACE_ID, PROJECT_ID);

		const detailQuery = queries[1]!.query;
		expect(detailQuery).toContain(
			"if(length(observations.input_text) > 8192, substringUTF8(observations.input_text, 1, 2048), observations.input_text) AS input_text",
		);
		expect(detailQuery).toContain(
			"if(length(observations.output_text) > 8192, substringUTF8(observations.output_text, 1, 2048), observations.output_text) AS output_text",
		);
		expect(detailQuery).toContain(
			"input_retained_truncated OR length(observations.input_text) > 8192 AS input_retained_truncated",
		);
		expect(detailQuery).toContain(
			"output_retained_truncated OR length(observations.output_text) > 8192 AS output_retained_truncated",
		);
	});

	it("uses a project-scoped keyset boundary instead of offset pagination", async () => {
		const { client, queries } = fakeClient();
		await listTraces(
			client as never,
			{ organization_id: ORGANIZATION_ID, project_id: PROJECT_ID },
			50,
			{ start_time: "2026-08-30 12:00:00.000", id: TRACE_ID },
		);

		const request = queries[0]!;
		expect(request.query).toContain(
			"(start_time, trace_id) < ({cursor_start_time: DateTime64(3)}, {cursor_id: String})",
		);
		expect(request.query.includes("OFFSET")).toBe(false);
		expect(request.query_params).toMatchObject({
			organization_id: ORGANIZATION_ID,
			project_id: PROJECT_ID,
			cursor_start_time: "2026-08-30 12:00:00.000",
			cursor_id: TRACE_ID,
		});
	});

	it("applies a v1 offset at the ClickHouse query boundary", async () => {
		const { client, queries } = fakeClient();
		await listObservations(
			client as never,
			{ organization_id: ORGANIZATION_ID, project_id: PROJECT_ID },
			10,
			undefined,
			25,
		);

		expect(queries[0]).toMatchObject({
			query: expect.stringMatching(
				/input_retained_truncated OR length\(observations\.input_text\) > 8192 AS input_retained_truncated[\s\S]*LIMIT \{limit: UInt32\} OFFSET \{offset: UInt32\}/,
			),
			query_params: { limit: 11, offset: 25 },
		});
	});

	it("returns an empty collection and zero total while preserving project scope", async () => {
		const queries: Array<{
			query: string;
			query_params: Record<string, unknown>;
		}> = [];
		const client = {
			query: async (request: {
				query: string;
				query_params: Record<string, unknown>;
			}) => {
				queries.push(request);
				return { json: async () => [] };
			},
		};

		const result = await listTraces(
			client as never,
			{ organization_id: ORGANIZATION_ID, project_id: PROJECT_ID },
			50,
			undefined,
		);

		expect(result).toEqual({ items: [], total: 0 });
		expect(queries).toHaveLength(2);
		for (const request of queries) {
			expect(request.query).toContain("project_id = {project_id: String}");
			expect(request.query_params).toMatchObject({
				organization_id: ORGANIZATION_ID,
				project_id: PROJECT_ID,
			});
		}
	});
});
