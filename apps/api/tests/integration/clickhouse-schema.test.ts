import { afterAll, describe, expect, it } from "bun:test";
import { createClient } from "@clickhouse/client";

const client = createClient({
	url:
		process.env.CLICKHOUSE_URL ??
		`http://${process.env.CLICKHOUSE_HOST ?? "localhost"}:8123`,
	database: process.env.CLICKHOUSE_DB ?? "astraea",
	username: process.env.CLICKHOUSE_USER ?? "astraea",
	password: process.env.CLICKHOUSE_PASSWORD ?? "",
});

async function values(query: string): Promise<string[]> {
	const result = await client.query({ query, format: "JSONEachRow" });
	const rows = (await result.json()) as Array<{ name: string }>;
	return rows.map((row) => row.name);
}

afterAll(async () => {
	await client.close();
});

describe("ClickHouse schema integration", () => {
	it("has the tenancy-scoped trace and observation tables", async () => {
		const tables = await values(
			"SELECT name FROM system.tables WHERE database = currentDatabase() AND name IN ('traces', 'observations') ORDER BY name",
		);
		expect(tables).toEqual(["observations", "traces"]);

		const traceColumns = await values(
			"SELECT name FROM system.columns WHERE database = currentDatabase() AND table = 'traces' ORDER BY position",
		);
		expect(traceColumns).toEqual([
			"trace_id",
			"organization_id",
			"project_id",
			"name",
			"start_time",
			"end_time",
			"duration_ms",
			"status",
			"user_id",
			"session_id",
			"agent_id",
			"agent_version",
			"env",
			"tags",
			"input_text",
			"output_text",
			"scores_summary",
			"metadata",
		]);

		const observationColumns = await values(
			"SELECT name FROM system.columns WHERE database = currentDatabase() AND table = 'observations' ORDER BY position",
		);
		expect(observationColumns).toEqual([
			"observation_id",
			"trace_id",
			"organization_id",
			"project_id",
			"parent_observation_id",
			"type",
			"name",
			"start_time",
			"end_time",
			"duration_ms",
			"status",
			"model",
			"input_text",
			"output_text",
			"metadata",
		]);
	});

	it("has every expected data-skipping index", async () => {
		const indices = await values(
			"SELECT name FROM system.data_skipping_indices WHERE database = currentDatabase() AND table IN ('traces', 'observations') ORDER BY name",
		);
		expect(indices).toEqual([
			"idx_agent",
			"idx_env",
			"idx_input_text",
			"idx_obs_input_text",
			"idx_obs_output_text",
			"idx_obs_status",
			"idx_obs_trace_id",
			"idx_obs_type",
			"idx_output_text",
			"idx_session",
			"idx_status",
			"idx_tags",
			"idx_user",
		]);
	});
});
