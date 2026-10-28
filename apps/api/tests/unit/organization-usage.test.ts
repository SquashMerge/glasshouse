import { describe, expect, it } from "bun:test";
import { getOrganizationUsage } from "../../src/db/organization-usage";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ONE = "11111111-1111-4111-8111-111111111111";
const PROJECT_TWO = "22222222-2222-4222-8222-222222222222";
const PROJECT_ZERO = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-28T12:34:56.789Z");

const projects = [
	{ id: PROJECT_ONE, name: "One", slug: "one", status: "active" as const },
	{ id: PROJECT_TWO, name: "Two", slug: "two", status: "archived" as const },
	{ id: PROJECT_ZERO, name: "Zero", slug: "zero", status: "active" as const },
];

describe("organization usage aggregates", () => {
	it("returns same-org project totals, reconciled org totals, and UTC time buckets", async () => {
		const requests: Array<{
			query: string;
			query_params: Record<string, unknown>;
		}> = [];
		const client = {
			query: async (request: {
				query: string;
				query_params: Record<string, unknown>;
			}) => {
				requests.push(request);
				return {
					json: async () => [
						{
							project_id: PROJECT_ONE,
							bucket_ms: String(Date.parse("2026-10-28T10:00:00.000Z")),
							record_kind: "traces",
							observation_type: "",
							count: "3",
						},
						{
							project_id: PROJECT_TWO,
							bucket_ms: String(Date.parse("2026-10-28T10:00:00.000Z")),
							record_kind: "traces",
							observation_type: "",
							count: "1",
						},
						{
							project_id: PROJECT_ONE,
							bucket_ms: String(Date.parse("2026-10-28T10:00:00.000Z")),
							record_kind: "observations",
							observation_type: "span",
							count: "2",
						},
						{
							project_id: PROJECT_ONE,
							bucket_ms: String(Date.parse("2026-10-28T11:00:00.000Z")),
							record_kind: "traces",
							observation_type: "",
							count: "1",
						},
						{
							project_id: PROJECT_ONE,
							bucket_ms: String(Date.parse("2026-10-28T11:00:00.000Z")),
							record_kind: "observations",
							observation_type: "generation",
							count: "3",
						},
						{
							project_id: PROJECT_TWO,
							bucket_ms: String(Date.parse("2026-10-28T11:00:00.000Z")),
							record_kind: "observations",
							observation_type: "event",
							count: "1",
						},
					],
				};
			},
		};

		const usage = await getOrganizationUsage(client as never, {
			organization_id: ORGANIZATION_ID,
			projects,
			range: "24h",
			now: NOW,
		});

		expect(requests).toHaveLength(1);
		for (const request of requests) {
			expect(request.query).toContain(
				"organization_id = {organization_id: String}",
			);
			expect(request.query).toContain(
				"project_id IN {project_ids: Array(String)}",
			);
			expect(request.query_params).toMatchObject({
				organization_id: ORGANIZATION_ID,
				project_ids: [PROJECT_ONE, PROJECT_TWO, PROJECT_ZERO],
			});
			expect(request.query).not.toMatch(
				/input_text|output_text|metadata|scores_summary/,
			);
			expect(request.query_params).toMatchObject({
				time_from: "2026-10-27 12:34:56.789",
				time_to: "2026-10-28 12:34:56.789",
			});
		}
		expect(usage).toMatchObject({
			range: "24h",
			from: "2026-10-27T12:34:56.789Z",
			to: "2026-10-28T12:34:56.789Z",
			projects: [
				{
					id: PROJECT_ONE,
					traces: 4,
					observations: 5,
					observations_by_type: { span: 2, event: 0, generation: 3, tool: 0 },
				},
				{
					id: PROJECT_TWO,
					traces: 1,
					observations: 1,
					observations_by_type: { span: 0, event: 1, generation: 0, tool: 0 },
				},
				{
					id: PROJECT_ZERO,
					traces: 0,
					observations: 0,
					observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
				},
			],
			totals: {
				traces: 5,
				observations: 6,
				observations_by_type: { span: 2, event: 1, generation: 3, tool: 0 },
			},
		});
		expect(usage.series).toHaveLength(25);
		expect(usage.series[0]).toMatchObject({
			bucket_start: "2026-10-27T12:00:00.000Z",
			traces: 0,
			observations: 0,
		});
		expect(
			usage.series.find(
				(bucket) => bucket.bucket_start === "2026-10-28T10:00:00.000Z",
			),
		).toMatchObject({ traces: 4, observations: 2 });
		expect(
			usage.series.find(
				(bucket) => bucket.bucket_start === "2026-10-28T11:00:00.000Z",
			),
		).toMatchObject({ traces: 1, observations: 4 });
		expect(usage.series.reduce((sum, bucket) => sum + bucket.traces, 0)).toBe(
			usage.totals.traces,
		);
		expect(
			usage.series.reduce((sum, bucket) => sum + bucket.observations, 0),
		).toBe(usage.totals.observations);
	});

	it("uses only supported rolling windows and returns a complete UTC bucket series", async () => {
		for (const [range, bucketMs, bucketCount] of [
			["24h", 60 * 60 * 1000, 25],
			["7d", 24 * 60 * 60 * 1000, 8],
			["30d", 24 * 60 * 60 * 1000, 31],
			["90d", 24 * 60 * 60 * 1000, 91],
		] as const) {
			let query = "";
			const client = {
				query: async (request: { query: string }) => {
					query = request.query;
					return { json: async () => [] };
				},
			};
			const usage = await getOrganizationUsage(client as never, {
				organization_id: ORGANIZATION_ID,
				projects,
				range,
				now: NOW,
			});
			expect(usage.range).toBe(range);
			expect(usage.series).toHaveLength(bucketCount);
			expect(usage.series[0]?.bucket_start).toBe(
				new Date(
					Math.floor(
						(NOW.getTime() -
							bucketMs *
								(range === "24h"
									? 24
									: range === "7d"
										? 7
										: range === "30d"
											? 30
											: 90)) /
							bucketMs,
					) * bucketMs,
				).toISOString(),
			);
			expect(query).toContain(
				`intDiv(toUnixTimestamp64Milli(start_time), ${bucketMs}) * ${bucketMs} AS bucket_ms`,
			);
		}
	});

	it("does not query ClickHouse when the organization has no eligible projects", async () => {
		let queryCount = 0;
		const client = {
			query: async () => {
				queryCount += 1;
				return { json: async () => [] };
			},
		};
		const usage = await getOrganizationUsage(client as never, {
			organization_id: ORGANIZATION_ID,
			projects: [],
			range: "7d",
			now: NOW,
		});

		expect(queryCount).toBe(0);
		expect(usage.projects).toEqual([]);
		expect(usage.totals).toEqual({
			traces: 0,
			observations: 0,
			observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
		});
		expect(usage.series).toHaveLength(8);
	});
});
