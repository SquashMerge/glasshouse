import { describe, expect, it } from "bun:test";
import { getTrace } from "../../src/db/traces-query";

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
		await getTrace(client as never, ORGANIZATION_ID, TRACE_ID, PROJECT_ID);

		expect(queries).toHaveLength(2);
		expect(queries[0]).toMatchObject({
			query: expect.stringContaining("project_id = {project_id: String}"),
			query_params: {
				organization_id: ORGANIZATION_ID,
				trace_id: TRACE_ID,
				project_id: PROJECT_ID,
			},
		});
		expect(queries[1]).toMatchObject({
			query: expect.stringContaining("LIMIT {limit: UInt32}"),
			query_params: {
				organization_id: ORGANIZATION_ID,
				trace_id: TRACE_ID,
				project_id: PROJECT_ID,
				limit: 5_000,
			},
		});
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
