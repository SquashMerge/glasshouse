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

		expect(queries).toHaveLength(6);
		expect(queries.every((query) => query.length > 0)).toBe(true);
		expect(queries[0]).toContain("CREATE TABLE IF NOT EXISTS traces");
		expect(queries[1]).toContain("ADD INDEX IF NOT EXISTS idx_status");
		expect(queries[2]).toContain("CREATE TABLE IF NOT EXISTS observations");
		expect(queries[3]).toContain("ADD INDEX IF NOT EXISTS idx_obs_trace_id");
		expect(queries[4]).toContain("ALTER TABLE traces");
		expect(queries[5]).toContain("ALTER TABLE observations");
		expect(closed).toBe(true);
	});
});
