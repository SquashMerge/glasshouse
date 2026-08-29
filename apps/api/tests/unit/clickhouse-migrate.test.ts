import { describe, expect, it } from "bun:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Client } from "pg";
import {
	applyClickHouseMigrations,
	withClickHouseMigrationLock,
} from "../../src/db/clickhouse-migrate";

const withoutMigrationLock = async <T>(run: () => Promise<T>): Promise<T> =>
	run();

describe("ClickHouse migrations", () => {
	it("records applied changesets and skips them on the next startup", async () => {
		const commands: string[] = [];
		const applied = new Map<string, string>();
		let closed = 0;
		const client = {
			command: async ({
				query,
				query_params,
			}: {
				query: string;
				query_params?: { migration: string; checksum: string };
			}) => {
				commands.push(query);
				if (query.startsWith("INSERT INTO astraea_schema_migrations"))
					applied.set(query_params!.migration, query_params!.checksum);
			},
			query: async () => ({
				json: async () =>
					[...applied].map(([migration, checksum]) => ({
						migration,
						checksum,
					})),
			}),
			close: async () => {
				closed += 1;
			},
		} as unknown as ClickHouseClient;

		await applyClickHouseMigrations(client, withoutMigrationLock);

		const migrationStatements = commands.filter(
			(query) =>
				!query.includes("astraea_schema_migrations") &&
				!query.startsWith("INSERT INTO"),
		);
		expect(migrationStatements).toHaveLength(12);
		expect(migrationStatements.every((query) => query.length > 0)).toBe(true);
		expect(migrationStatements[0]).toContain(
			"CREATE TABLE IF NOT EXISTS traces",
		);
		expect(migrationStatements[1]).toContain(
			"ADD INDEX IF NOT EXISTS idx_status",
		);
		expect(migrationStatements[2]).toContain(
			"CREATE TABLE IF NOT EXISTS observations",
		);
		expect(migrationStatements[3]).toContain(
			"ADD INDEX IF NOT EXISTS idx_obs_trace_id",
		);
		expect(migrationStatements[4]).toContain("ALTER TABLE traces");
		expect(migrationStatements[5]).toContain("ALTER TABLE observations");
		expect(migrationStatements[6]).toContain("ALTER TABLE traces");
		expect(migrationStatements[6]).toContain(
			"non_replicated_deduplication_window",
		);
		expect(migrationStatements[7]).toContain("ALTER TABLE observations");
		expect(migrationStatements[7]).toContain(
			"non_replicated_deduplication_window",
		);
		expect(migrationStatements[8]).toContain(
			"ADD CONSTRAINT IF NOT EXISTS traces_tenant_scope_required",
		);
		expect(migrationStatements[8]).toContain(
			"CHECK notEmpty(organization_id) AND notEmpty(project_id)",
		);
		expect(migrationStatements[9]).toContain(
			"ADD CONSTRAINT IF NOT EXISTS observations_tenant_scope_required",
		);
		expect(migrationStatements[9]).toContain(
			"CHECK notEmpty(organization_id) AND notEmpty(project_id)",
		);
		expect(migrationStatements[10]).toContain("ALTER TABLE traces");
		expect(migrationStatements[10]).toContain("DELETE WHERE");
		expect(migrationStatements[10]).toContain("mutations_sync = 2");
		expect(migrationStatements[11]).toContain("ALTER TABLE observations");
		expect(migrationStatements[11]).toContain("DELETE WHERE");
		expect(migrationStatements[11]).toContain("mutations_sync = 2");

		const commandsAfterFirstStartup = commands.length;
		await applyClickHouseMigrations(client, withoutMigrationLock);

		expect(commands.slice(commandsAfterFirstStartup)).toEqual([
			expect.stringContaining(
				"CREATE TABLE IF NOT EXISTS astraea_schema_migrations",
			),
		]);
		expect(closed).toBe(2);
	});

	it("serializes concurrent startup migration runners", async () => {
		const applied = new Map<string, string>();
		let inserted = 0;
		const client = {
			command: async ({
				query,
				query_params,
			}: {
				query: string;
				query_params?: { migration: string; checksum: string };
			}) => {
				if (query.startsWith("INSERT INTO astraea_schema_migrations")) {
					inserted += 1;
					applied.set(query_params!.migration, query_params!.checksum);
				}
			},
			query: async () => ({
				json: async () =>
					[...applied].map(([migration, checksum]) => ({
						migration,
						checksum,
					})),
			}),
			close: async () => {},
		} as unknown as ClickHouseClient;
		let nextLock = Promise.resolve();
		const serializedMigrationLock = async <T>(
			run: () => Promise<T>,
		): Promise<T> => {
			const previousLock = nextLock;
			let releaseLock!: () => void;
			nextLock = new Promise<void>((resolve) => {
				releaseLock = resolve;
			});
			await previousLock;
			try {
				return await run();
			} finally {
				releaseLock();
			}
		};

		await Promise.all([
			applyClickHouseMigrations(client, serializedMigrationLock),
			applyClickHouseMigrations(client, serializedMigrationLock),
		]);

		expect(inserted).toBe(5);
		expect(applied).toHaveLength(5);
	});

	it("holds a PostgreSQL advisory lock for the full ClickHouse migration run", async () => {
		const calls: string[] = [];
		const lockClient = {
			connect: async () => {
				calls.push("connect");
			},
			query: async (query: string) => {
				calls.push(query);
			},
			end: async () => {
				calls.push("end");
			},
		} as unknown as Client;

		await withClickHouseMigrationLock(
			async () => {
				calls.push("run");
			},
			() => lockClient,
		);

		expect(calls).toEqual([
			"connect",
			"SELECT pg_advisory_lock(hashtext($1))",
			"run",
			"SELECT pg_advisory_unlock(hashtext($1))",
			"end",
		]);
	});

	it("releases the PostgreSQL advisory lock when a migration fails", async () => {
		const calls: string[] = [];
		const lockClient = {
			connect: async () => {
				calls.push("connect");
			},
			query: async (query: string) => {
				calls.push(query);
			},
			end: async () => {
				calls.push("end");
			},
		} as unknown as Client;

		await expect(
			withClickHouseMigrationLock(
				async () => {
					throw new Error("migration failed");
				},
				() => lockClient,
			),
		).rejects.toThrow("migration failed");

		expect(calls).toEqual([
			"connect",
			"SELECT pg_advisory_lock(hashtext($1))",
			"SELECT pg_advisory_unlock(hashtext($1))",
			"end",
		]);
	});
});
