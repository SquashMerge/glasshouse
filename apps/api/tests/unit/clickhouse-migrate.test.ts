import { describe, expect, it } from "bun:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate";

describe("ClickHouse migrations", () => {
	it("applies every SQL statement in order and closes the client", async () => {
		const queries: string[] = [];
		let closed = false;
		const client = {
			command: async ({ query }: { query: string }) => {
				queries.push(query);
			},
			close: async () => {
				closed = true;
			},
		} as unknown as ClickHouseClient;

		await applyClickHouseMigrations(client);

		expect(queries).toHaveLength(12);
		expect(queries.every((query) => query.length > 0)).toBe(true);
		expect(queries[0]).toContain("CREATE TABLE IF NOT EXISTS traces");
		expect(queries[1]).toContain("ADD INDEX IF NOT EXISTS idx_status");
		expect(queries[2]).toContain("CREATE TABLE IF NOT EXISTS observations");
		expect(queries[3]).toContain("ADD INDEX IF NOT EXISTS idx_obs_trace_id");
		expect(queries[4]).toContain("ALTER TABLE traces");
		expect(queries[5]).toContain("ALTER TABLE observations");
		expect(queries[6]).toContain("ALTER TABLE traces");
		expect(queries[6]).toContain("non_replicated_deduplication_window");
		expect(queries[7]).toContain("ALTER TABLE observations");
		expect(queries[7]).toContain("non_replicated_deduplication_window");
		expect(queries[8]).toContain("ALTER TABLE traces");
		expect(queries[8]).toContain("DELETE WHERE");
		expect(queries[8]).toContain("mutations_sync = 2");
		expect(queries[9]).toContain("ALTER TABLE observations");
		expect(queries[9]).toContain("DELETE WHERE");
		expect(queries[9]).toContain("mutations_sync = 2");
		expect(queries[10]).toContain(
			"ADD CONSTRAINT IF NOT EXISTS traces_tenant_scope_required",
		);
		expect(queries[10]).toContain(
			"CHECK notEmpty(organization_id) AND notEmpty(project_id)",
		);
		expect(queries[11]).toContain(
			"ADD CONSTRAINT IF NOT EXISTS observations_tenant_scope_required",
		);
		expect(queries[11]).toContain(
			"CHECK notEmpty(organization_id) AND notEmpty(project_id)",
		);
		expect(closed).toBe(true);
	});
});
