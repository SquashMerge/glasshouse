import { randomBytes, randomUUID } from "node:crypto";
import { test, expect, type APIResponse } from "@playwright/test";
import type {
	OrganizationUsageDashboard,
	OrganizationUsageRange,
	Project,
} from "../../src/lib/api";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:3000";
const USER = process.env.UI_USERNAME ?? "glasshouse";
const PASS = process.env.UI_PASSWORD ?? "testpassword";
const headers = {
	authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`,
};

async function json<T>(response: APIResponse, status = 200): Promise<T> {
	expect(response.status(), "API response status").toBe(status);
	return (await response.json()) as T;
}

test("API integration: real OTLP ingestion populates organization usage across ranges and archival", async ({
	request,
}) => {
	const slug = `usage-api-${randomUUID()}`;
	const project = await json<Project>(
		await request.post(`${API_BASE}/v1/projects`, {
			headers,
			data: { name: slug, slug },
		}),
		201,
	);
	let isArchived = false;
	try {
		const usage = async (range: OrganizationUsageRange) =>
			json<OrganizationUsageDashboard>(
				await request.get(`${API_BASE}/v1/organization/usage`, {
					headers,
					params: { range },
				}),
			);
		const empty = await usage("30d");
		expect(empty.projects.find((item) => item.id === project.id)).toEqual({
			id: project.id,
			name: project.name,
			slug: project.slug,
			status: "active",
			traces: 0,
			observations: 0,
			observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
		});

		const recentMs = Math.floor(Date.now() / 1000) * 1000 - 60_000;
		const historicalMs = recentMs - 40 * 24 * 60 * 60 * 1000;
		const rootId = randomBytes(8).toString("hex");
		const traceId = randomBytes(16).toString("hex");
		const payloadMarker = `private-usage-payload-${randomUUID()}`;
		const span = (startMs: number, trace = randomBytes(16).toString("hex")) => ({
			trace_id: trace,
			span_id: randomBytes(8).toString("hex"),
			name: payloadMarker,
			kind: 1,
			start_time_unix_nano: (BigInt(startMs) * 1_000_000n).toString(),
			end_time_unix_nano: (BigInt(startMs + 100) * 1_000_000n).toString(),
			status: { code: 1 },
			attributes: [],
		});
		const ingested = await request.post(`${API_BASE}/v1/otel/v1/traces`, {
			headers: { ...headers, "x-glasshouse-project-id": project.id },
			data: {
				resource_spans: [
					{
						resource: {
							attributes: [
								{
									key: "service.name",
									value: { stringValue: "usage-api-e2e" },
								},
								{
									key: "glasshouse.project.id",
									value: { stringValue: project.id },
								},
							],
						},
						scope_spans: [
							{
								spans: [
									{ ...span(recentMs, traceId), span_id: rootId },
									{
										...span(recentMs, traceId),
										parent_span_id: rootId,
										attributes: [
											{
												key: "gen_ai.request.model",
												value: { stringValue: "e2e-model" },
											},
											{
												key: "gen_ai.prompt.0.content",
												value: { stringValue: payloadMarker },
											},
										],
									},
									{
										...span(recentMs, traceId),
										parent_span_id: rootId,
										attributes: [
											{
												key: "tool.name",
												value: { stringValue: "usage-test-tool" },
											},
										],
									},
									span(recentMs),
									span(historicalMs),
								],
							},
						],
					},
				],
			},
		});
		expect(await json(ingested)).toEqual({ partial_success: {} });

		for (const range of ["24h", "7d", "30d", "90d"] as const) {
			const dashboard = await usage(range);
			const includesHistorical = range === "90d";
			const counts = {
				traces: includesHistorical ? 3 : 2,
				observations: includesHistorical ? 5 : 4,
				// OTLP classification produces span/generation/tool, not event rows.
				observations_by_type: {
					span: includesHistorical ? 3 : 2,
					event: 0,
					generation: 1,
					tool: 1,
				},
			};
			expect(dashboard.range).toBe(range);
			expect(dashboard.projects.find((item) => item.id === project.id)).toEqual({
				id: project.id,
				name: project.name,
				slug: project.slug,
				status: "active",
				...counts,
			});
			for (const key of ["traces", "observations"] as const) {
				expect(dashboard.totals[key]).toBe(
					dashboard.projects.reduce((sum, item) => sum + item[key], 0),
				);
				expect(dashboard.totals[key]).toBe(
					dashboard.series.reduce((sum, bucket) => sum + bucket[key], 0),
				);
			}
			for (const type of ["span", "event", "generation", "tool"] as const) {
				expect(dashboard.totals.observations_by_type[type]).toBe(
					dashboard.projects.reduce(
						(sum, item) => sum + item.observations_by_type[type],
						0,
					),
				);
				expect(dashboard.totals.observations_by_type[type]).toBe(
					dashboard.series.reduce(
						(sum, bucket) => sum + bucket.observations_by_type[type],
						0,
					),
				);
			}
			const bucketMs = range === "24h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
			const bucketStart = new Date(
				Math.floor(recentMs / bucketMs) * bucketMs,
			).toISOString();
			const bucket = dashboard.series.find(
				(item) => item.bucket_start === bucketStart,
			);
			expect(bucket?.traces).toBeGreaterThanOrEqual(2);
			expect(bucket?.observations).toBeGreaterThanOrEqual(4);
			expect(JSON.stringify(dashboard)).not.toContain(payloadMarker);
		}

		const archived = await json<Project>(
			await request.post(`${API_BASE}/v1/projects/${project.id}/archive`, {
				headers,
			}),
		);
		isArchived = archived.status === "archived";
		expect(archived.status).toBe("archived");
		const afterArchive = await usage("30d");
		expect(afterArchive.projects.find((item) => item.id === project.id)).toEqual({
			id: project.id,
			name: project.name,
			slug: project.slug,
			status: "archived",
			traces: 2,
			observations: 4,
			observations_by_type: { span: 2, event: 0, generation: 1, tool: 1 },
		});
	} finally {
		if (isArchived) {
			const restored = await json<Project>(
				await request.post(`${API_BASE}/v1/projects/${project.id}/restore`, {
					headers,
				}),
			);
			expect(restored.status).toBe("active");
		}
		const deleted = await request.delete(`${API_BASE}/v1/projects/${project.id}`, {
			headers,
			data: { confirmation_name: project.name },
		});
		expect(deleted.status(), "usage fixture Project cleanup").toBe(204);
	}
});
