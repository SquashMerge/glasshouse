import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Client } from "pg";
import {
	applyClickHouseMigrations,
	withClickHouseMigrationLock,
} from "../../src/db/clickhouse-migrate";

const withoutMigrationLock = async <T>(run: () => Promise<T>): Promise<T> =>
	run();

function migrationClient(mock: object): ClickHouseClient {
	const client = mock as ClickHouseClient;
	client.exec = async (request) => {
		await client.command(request);
		return { stream: Readable.from([]) } as never;
	};
	return client;
}

function queryRows(query: string, applied: Map<string, string>) {
	if (query.includes("system.mutations"))
		return [{ pending: "0", failed: "0" }];
	if (query.includes("AS needs_backfill")) return [{ needs_backfill: 1 }];
	return [...applied].map(([migration, checksum]) => ({ migration, checksum }));
}

describe("ClickHouse migrations", () => {
	it("bounds real Bun migration response bodies and closes their peer connections", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"--no-env-file",
				"test",
				new URL(
					"../fixtures/clickhouse-migrate-timeout.test.ts",
					import.meta.url,
				).pathname,
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, GLASSHOUSE_CONTAINER_NETWORK: "0" },
				timeout: 10_000,
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, `${stdout}\n${stderr}`).toBe(0);
		expect(stderr).toContain("6 pass");
	}, 15_000);

	it("records applied changesets and skips them on the next startup", async () => {
		const commands: string[] = [];
		const applied = new Map<string, string>();
		let closed = 0;
		const client = migrationClient({
			command: async ({
				query,
				query_params,
			}: {
				query: string;
				query_params?: { migration: string; checksum: string };
			}) => {
				commands.push(query);
				if (query.startsWith("INSERT INTO glasshouse_schema_migrations"))
					applied.set(query_params!.migration, query_params!.checksum);
			},
			query: async ({ query }: { query: string }) => ({
				json: async () => queryRows(query, applied),
			}),
			close: async () => {
				closed += 1;
			},
		});

		await applyClickHouseMigrations(client, withoutMigrationLock);

		const migrationStatements = commands.filter(
			(query) =>
				!query.includes("glasshouse_schema_migrations") &&
				!query.startsWith("INSERT INTO"),
		);
		expect(migrationStatements).toHaveLength(27);
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
		expect(migrationStatements[12]).toContain(
			"ADD CONSTRAINT IF NOT EXISTS traces_retained_payload_bounds",
		);
		expect(migrationStatements[12]).toContain("length(input_text) <= 8192");
		expect(migrationStatements[13]).toContain(
			"ADD CONSTRAINT IF NOT EXISTS observations_retained_payload_bounds",
		);
		expect(migrationStatements[13]).toContain("length(metadata) <= 16384");
		expect(migrationStatements[14]).toContain(
			"ADD COLUMN IF NOT EXISTS input_retained_truncated Bool DEFAULT false",
		);
		expect(migrationStatements[15]).toContain(
			"ADD COLUMN IF NOT EXISTS output_retained_truncated Bool DEFAULT false",
		);
		const logs = migrationStatements.find((query) =>
			query.startsWith("CREATE TABLE IF NOT EXISTS logs"),
		);
		expect(logs).toContain("time_unix_nano UInt64");
		expect(logs).toContain("observed_time_unix_nano UInt64");
		expect(logs).toContain(
			"CHECK notEmpty(organization_id) AND notEmpty(project_id)",
		);
		expect(migrationStatements[21]).toContain(
			"CREATE TABLE IF NOT EXISTS metrics",
		);
		expect(migrationStatements[21]).toContain("metrics_tenant_scope_required");
		expect(migrationStatements[21]).toContain(
			"metrics_retained_payload_bounds",
		);
		expect(applied.has("0010_otlp_metrics.sql")).toBe(true);
		expect(migrationStatements[22]).toBe(
			"ALTER TABLE logs MODIFY SETTING enable_block_number_column = 1, enable_block_offset_column = 1",
		);
		expect(applied.has("0011_logs_physical_row_identity.sql")).toBe(true);
		expect(migrationStatements[23]).toContain(
			"ADD COLUMN IF NOT EXISTS physical_row_id UUID DEFAULT",
		);
		expect(migrationStatements[23]).toContain("logs_physical_row_id_v4");
		expect(migrationStatements[24]).toContain(
			"generateUUIDv4(), physical_row_id) WHERE 1 SETTINGS mutations_sync = 0",
		);
		expect(applied.has("0012_logs_physical_uuid.sql")).toBe(true);

		const commandsAfterFirstStartup = commands.length;
		await applyClickHouseMigrations(client, withoutMigrationLock);

		expect(commands.slice(commandsAfterFirstStartup)).toEqual([
			expect.stringContaining(
				"CREATE TABLE IF NOT EXISTS glasshouse_schema_migrations",
			),
		]);
		expect(closed).toBe(2);
	});

	it("serializes concurrent startup migration runners", async () => {
		const applied = new Map<string, string>();
		let inserted = 0;
		const client = migrationClient({
			command: async ({
				query,
				query_params,
			}: {
				query: string;
				query_params?: { migration: string; checksum: string };
			}) => {
				if (query.startsWith("INSERT INTO glasshouse_schema_migrations")) {
					inserted += 1;
					applied.set(query_params!.migration, query_params!.checksum);
				}
			},
			query: async ({ query }: { query: string }) => ({
				json: async () => queryRows(query, applied),
			}),
			close: async () => {},
		});
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

		expect(inserted).toBe(12);
		expect(applied).toHaveLength(12);
	});

	it("rejects a published checksum mismatch before executing pending SQL", async () => {
		const commands: string[] = [];
		let closed = false;
		const client = migrationClient({
			command: async ({ query }: { query: string }) => {
				commands.push(query);
			},
			query: async () => ({
				json: async () => [
					{ migration: "0001_traces.sql", checksum: "mismatched" },
				],
			}),
			close: async () => {
				closed = true;
			},
		});
		await expect(
			applyClickHouseMigrations(client, withoutMigrationLock),
		).rejects.toThrow("ClickHouse migration checksum changed: 0001_traces.sql");
		expect(commands).toEqual([
			expect.stringContaining(
				"CREATE TABLE IF NOT EXISTS glasshouse_schema_migrations",
			),
		]);
		expect(closed).toBe(true);
	});

	it("does not submit a mutation for an already materialized fresh empty schema", async () => {
		const commands: string[] = [];
		const client = migrationClient({
			command: async ({ query }: { query: string }) => {
				commands.push(query);
			},
			query: async ({ query }: { query: string }) => ({
				json: async () =>
					query.includes("AS needs_backfill")
						? [{ needs_backfill: 0 }]
						: queryRows(query, new Map()),
			}),
			close: async () => {},
		});
		await applyClickHouseMigrations(client, withoutMigrationLock, {
			logsWriterMaintenance: false,
		});
		expect(
			commands.some((query) => query.startsWith("ALTER TABLE logs UPDATE")),
		).toBe(false);
		expect(commands).toContainEqual(
			expect.stringContaining("Physical log UUID backfill is incomplete"),
		);
		expect(commands).toContainEqual(
			expect.stringContaining("Physical log UUID column is not stored"),
		);
		expect(commands.at(-1)).toContain(
			"INSERT INTO glasshouse_schema_migrations",
		);
	});

	for (const timeout of [0, -1, Number.NaN, 3_600_001]) {
		it(`rejects invalid 0012 wait budget ${timeout} before UUID DDL or mutation`, async () => {
			const commands: string[] = [];
			const client = migrationClient({
				command: async ({ query }: { query: string }) => {
					commands.push(query);
				},
				query: async ({ query }: { query: string }) => ({
					json: async () => queryRows(query, new Map()),
				}),
				close: async () => {},
			});
			await expect(
				applyClickHouseMigrations(client, withoutMigrationLock, {
					logsUuidTimeoutMs: timeout,
				}),
			).rejects.toThrow("GLASSHOUSE_LOG_UUID_TIMEOUT_MS");
			expect(
				commands.some((query) => query.includes("physical_row_id UUID")),
			).toBe(false);
		});
	}

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

	it("closes the PostgreSQL session when advisory unlock fails", async () => {
		const calls: string[] = [];
		const lockClient = {
			connect: async () => {
				calls.push("connect");
			},
			query: async (query: string) => {
				calls.push(query);
				if (query.includes("pg_advisory_unlock"))
					throw new Error("unlock failed");
			},
			end: async () => {
				calls.push("end");
			},
		} as unknown as Client;

		await expect(
			withClickHouseMigrationLock(
				async () => undefined,
				() => lockClient,
			),
		).rejects.toThrow("unlock failed");

		expect(calls).toEqual([
			"connect",
			"SELECT pg_advisory_lock(hashtext($1))",
			"SELECT pg_advisory_unlock(hashtext($1))",
			"end",
		]);
	});
});
