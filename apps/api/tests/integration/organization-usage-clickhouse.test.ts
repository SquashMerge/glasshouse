import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createClient } from "@clickhouse/client";
import { clickhouseUrl } from "../../src/db/clickhouse.js";
import { getOrganizationUsage } from "../../src/db/organization-usage.js";

const database = `usage_test_${crypto.randomUUID().replaceAll("-", "")}`;
const connection = {
	url: clickhouseUrl(),
	username: process.env.CLICKHOUSE_USER ?? "glasshouse",
	password: process.env.CLICKHOUSE_PASSWORD ?? "",
};
const admin = createClient({
	...connection,
	database: process.env.CLICKHOUSE_DB ?? "glasshouse",
});
const client = createClient({ ...connection, database });
const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-28T12:00:00.000Z");

beforeAll(async () => {
	await admin.command({ query: `CREATE DATABASE ${database}` });
	await client.command({
		query: `CREATE TABLE traces (
			organization_id String,
			project_id String,
			start_time DateTime64(3)
		) ENGINE = MergeTree ORDER BY (organization_id, project_id, start_time)`,
	});
	await client.command({
		query: `CREATE TABLE observations (
			organization_id String,
			project_id String,
			start_time DateTime64(3),
			type LowCardinality(String)
		) ENGINE = MergeTree ORDER BY (organization_id, project_id, start_time)`,
	});
	await client.insert({
		table: "traces",
		format: "JSONEachRow",
		values: [
			{
				organization_id: organizationId,
				project_id: projectId,
				start_time: "2026-10-27 12:00:00.000",
			},
			{
				organization_id: organizationId,
				project_id: projectId,
				start_time: "2026-10-28 12:00:00.000",
			},
			{
				organization_id: otherOrganizationId,
				project_id: projectId,
				start_time: "2026-10-28 11:00:00.000",
			},
			{
				organization_id: organizationId,
				project_id: otherProjectId,
				start_time: "2026-10-28 11:00:00.000",
			},
		],
	});
	await client.insert({
		table: "observations",
		format: "JSONEachRow",
		values: [
			{
				organization_id: organizationId,
				project_id: projectId,
				start_time: "2026-10-27 12:00:00.000",
				type: "span",
			},
			{
				organization_id: organizationId,
				project_id: projectId,
				start_time: "2026-10-28 12:00:00.000",
				type: "generation",
			},
			{
				organization_id: otherOrganizationId,
				project_id: projectId,
				start_time: "2026-10-28 11:00:00.000",
				type: "tool",
			},
			{
				organization_id: organizationId,
				project_id: otherProjectId,
				start_time: "2026-10-28 11:00:00.000",
				type: "event",
			},
		],
	});
});

afterAll(async () => {
	try {
		await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
	} finally {
		await Promise.all([client.close(), admin.close()]);
	}
});

describe("organization usage ClickHouse integration", () => {
	it("uses inclusive/exclusive time bounds and organization/project scope", async () => {
		const usage = await getOrganizationUsage(client, {
			organization_id: organizationId,
			projects: [
				{
					id: projectId,
					name: "Included",
					slug: "included",
					status: "active",
				},
			],
			range: "24h",
			now,
		});

		expect(usage.from).toBe("2026-10-27T12:00:00.000Z");
		expect(usage.to).toBe("2026-10-28T12:00:00.000Z");
		expect(usage.totals).toEqual({
			traces: 1,
			observations: 1,
			observations_by_type: { span: 1, event: 0, generation: 0, tool: 0 },
		});
		expect(usage.projects).toHaveLength(1);
		expect(usage.projects[0]).toMatchObject({
			id: projectId,
			traces: 1,
			observations: 1,
		});
	});
});
