import { expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate.js";
import { otlpDisposableDatastores } from "../helpers/otlp-disposable-datastores.js";

const directory = new URL("../../../../infra/db/clickhouse/", import.meta.url);
const uuidV4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function uuidMigration() {
	const files = readdirSync(directory).filter((file) =>
		/^0012_.+\.sql$/.test(file),
	);
	expect(files).toHaveLength(1);
	return files[0]!;
}

function uuidStatements() {
	return readFileSync(new URL(uuidMigration(), directory), "utf8")
		.replace(/^--.*$/gm, "")
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
}

async function withPopulatedPreview(
	run: (
		client: ClickHouseClient,
		options: Parameters<typeof createClient>[0],
		database: string,
	) => Promise<void>,
	partType?: "Compact" | "Wide",
) {
	const database = `otlp_extension_${randomUUID().replaceAll("-", "")}`;
	const config = otlpDisposableDatastores(process.env, database);
	const admin = createClient(config.clickhouseAdminOptions);
	let created = false;
	let client: ClickHouseClient | undefined;
	try {
		await admin.command({ query: `CREATE DATABASE ${database}` });
		created = true;
		client = createClient(config.clickhouseOptions);
		await client.command({
			query:
				"CREATE TABLE glasshouse_schema_migrations (migration String, checksum String, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY migration",
		});
		const legacyMigrations = readdirSync(directory)
			.filter((file) => /^\d+_.+\.sql$/.test(file) && file < "0012_")
			.sort();
		for (const file of legacyMigrations) {
			const source = readFileSync(new URL(file, directory), "utf8");
			const statements = source
				.replace(/^--.*$/gm, "")
				.split(";")
				.map((value) => value.trim())
				.filter(Boolean);
			for (const query of statements) await client.command({ query });
			await client.command({
				query:
					"INSERT INTO glasshouse_schema_migrations (migration, checksum) VALUES ({migration:String}, {checksum:String})",
				query_params: {
					migration: file,
					checksum: createHash("sha256").update(source).digest("hex"),
				},
			});
		}
		if (partType) {
			const threshold = partType === "Wide" ? 0 : 1_000_000_000;
			await client.command({
				query: `ALTER TABLE logs MODIFY SETTING min_bytes_for_wide_part = ${threshold}, min_rows_for_wide_part = ${threshold}`,
			});
		}
		await client.command({
			query:
				"INSERT INTO logs (log_id, organization_id, project_id, ingested_time_unix_nano, body) VALUES ({b:String}, 'legacy-org', 'legacy-project', 1700000000000000000, '{\"stringValue\":\"legacy-duplicate\"}'), ({a:String}, 'legacy-org', 'legacy-project', 1700000000000000000, '{\"stringValue\":\"legacy-duplicate\"}'), ({a:String}, 'legacy-org', 'legacy-project', 1700000000000000000, '{\"stringValue\":\"legacy-duplicate\"}'), ({a:String}, 'legacy-org', 'legacy-project', 1700000000000000000, '{\"stringValue\":\"legacy-duplicate\"}')",
			query_params: { b: "b".repeat(64), a: "a".repeat(64) },
			clickhouse_settings: { async_insert: 0, insert_deduplicate: 0 },
		});
		await client.command({
			query:
				"INSERT INTO logs (log_id, organization_id, project_id, ingested_time_unix_nano) VALUES ('foreign-org', 'other-org', 'legacy-project', 1700000000000000000), ('foreign-project', 'legacy-org', 'other-project', 1700000000000000000)",
		});
		if (partType) {
			const parts = await client.query({
				query:
					"SELECT DISTINCT part_type FROM system.parts WHERE database = {database:String} AND table = 'logs' AND active",
				query_params: { database },
				format: "JSONEachRow",
			});
			expect(await parts.json()).toEqual([{ part_type: partType }]);
		}
		await run(client, config.clickhouseOptions, database);
	} finally {
		await client?.close();
		try {
			if (created)
				await admin.command({ query: `DROP DATABASE ${database} SYNC` });
		} finally {
			await admin.close();
		}
	}
}

async function snapshot(client: ClickHouseClient) {
	const result = await client.query({
		query:
			"SELECT * FROM logs ORDER BY organization_id, project_id, physical_row_id",
		format: "JSONEachRow",
	});
	return result.json<Record<string, unknown>>();
}

function payloads(rows: Array<Record<string, unknown>>) {
	return rows
		.map(({ physical_row_id: _physicalId, ...payload }) =>
			JSON.stringify(payload),
		)
		.sort();
}

async function mutations(client: ClickHouseClient) {
	const result = await client.query({
		query:
			"SELECT mutation_id, is_done, parts_to_do FROM system.mutations WHERE database = currentDatabase() AND table = 'logs' ORDER BY mutation_id",
		format: "JSONEachRow",
	});
	return result.json<{
		mutation_id: string;
		is_done: number;
		parts_to_do: string;
	}>();
}

async function untilDone(client: ClickHouseClient) {
	const deadline = Date.now() + 10_000;
	while ((await mutations(client)).some((mutation) => !mutation.is_done)) {
		if (Date.now() >= deadline)
			throw new Error("Fixture mutation did not finish");
		await Bun.sleep(50);
	}
}

async function expectUnrecorded(client: ClickHouseClient) {
	const result = await client.query({
		query:
			"SELECT migration FROM glasshouse_schema_migrations WHERE migration = {migration:String}",
		query_params: { migration: uuidMigration() },
		format: "JSONEachRow",
	});
	expect(await result.json()).toEqual([]);
}

test("0012 synchronous timeout leaves a background mutation and completed replay rewrites again", async () => {
	await withPopulatedPreview(async (client, options) => {
		const statements = uuidStatements();
		await client.command({ query: statements[0]! });
		const synchronous = statements
			.find((query) => query.startsWith("ALTER TABLE logs UPDATE"))!
			.replace("mutations_sync = 0", "mutations_sync = 2");
		await client.command({ query: "SYSTEM STOP MERGES logs" });
		try {
			const first = createClient(options);
			const started = Date.now();
			try {
				await expect(
					first.command({
						query: synchronous,
						abort_signal: AbortSignal.timeout(500),
					}),
				).rejects.toThrow();
			} finally {
				await first.close();
			}
			expect(Date.now() - started).toBeGreaterThanOrEqual(400);
			const pending = await mutations(client);
			expect(pending).toHaveLength(1);
			expect(pending[0]!.is_done).toBe(0);
			expect(Number(pending[0]!.parts_to_do)).toBeGreaterThan(0);
			await client.command({ query: "SYSTEM START MERGES logs" });
			await untilDone(client);
			const stored = await snapshot(client);
			for (const row of stored) expect(row.physical_row_id).toMatch(uuidV4);
			await client.command({ query: "SYSTEM STOP MERGES logs" });
			const retry = createClient({ ...options, request_timeout: 250 });
			try {
				await expect(
					retry.command({
						query: synchronous,
						abort_signal: AbortSignal.timeout(250),
					}),
				).rejects.toThrow();
			} finally {
				await retry.close();
			}
			const replay = await mutations(client);
			expect(replay).toHaveLength(2);
			expect(replay.filter((mutation) => !mutation.is_done)).toHaveLength(1);
			expect(await snapshot(client)).toEqual(stored);
		} finally {
			await client.command({ query: "SYSTEM START MERGES logs" });
			await untilDone(client);
		}
	});
}, 60_000);

test("0012 bounds asynchronous waiting and resumes a delayed mutation without resubmission", async () => {
	await withPopulatedPreview(async (client, options) => {
		const upgrade = (timeout: number, maintenance = true) =>
			applyClickHouseMigrations(createClient(options), async (run) => run(), {
				logsWriterMaintenance: maintenance,
				metricsWriterMaintenance: true,
				logsUuidTimeoutMs: timeout,
			});
		await client.command({ query: "SYSTEM STOP MERGES logs" });
		try {
			const started = Date.now();
			await expect(upgrade(750)).rejects.toThrow("0012 deadline exceeded");
			expect(Date.now() - started).toBeLessThan(3_000);
			await expectUnrecorded(client);
			const pending = await mutations(client);
			expect(pending).toHaveLength(1);
			expect(pending[0]!.is_done).toBe(0);
			await expect(upgrade(250, false)).rejects.toThrow(
				"GLASSHOUSE_LOG_UUID_MAINTENANCE=1",
			);
			await expect(upgrade(250)).rejects.toThrow("0012 deadline exceeded");
			expect(await mutations(client)).toEqual(pending);
			await expectUnrecorded(client);
			const resumed = upgrade(5_000);
			try {
				await Bun.sleep(200);
				expect(await mutations(client)).toEqual(pending);
				await expectUnrecorded(client);
			} finally {
				await client.command({ query: "SYSTEM START MERGES logs" });
				await resumed;
			}
			const stored = await snapshot(client);
			for (const row of stored) expect(row.physical_row_id).toMatch(uuidV4);
			expect(new Set(stored.map((row) => row.physical_row_id)).size).toBe(6);
			expect(
				(await mutations(client)).map((mutation) => mutation.mutation_id),
			).toEqual(pending.map((mutation) => mutation.mutation_id));
			await upgrade(5_000, false);
			expect(await snapshot(client)).toEqual(stored);
			expect(await mutations(client)).toHaveLength(1);
		} finally {
			await client.command({ query: "SYSTEM START MERGES logs" });
			await untilDone(client);
		}
	});
}, 30_000);

test("0012 recovers a lost asynchronous submission acknowledgement after background completion without rewriting", async () => {
	await withPopulatedPreview(async (client, options) => {
		await client.command({ query: "SYSTEM STOP MERGES logs" });
		try {
			const runner = createClient(options);
			const exec = runner.exec.bind(runner);
			const injection = spyOn(runner, "exec").mockImplementation(
				async (request) => {
					const result = await exec(request);
					if (request.query.startsWith("ALTER TABLE logs UPDATE")) {
						for await (const _chunk of result.stream) {
						}
						throw new Error("lost asynchronous acknowledgement");
					}
					return result;
				},
			);
			try {
				await expect(
					applyClickHouseMigrations(runner, async (run) => run(), {
						logsWriterMaintenance: true,
						metricsWriterMaintenance: true,
					}),
				).rejects.toThrow("lost asynchronous acknowledgement");
			} finally {
				injection.mockRestore();
			}
			const pending = await mutations(client);
			expect(pending).toHaveLength(1);
			expect(pending[0]!.is_done).toBe(0);
			await expectUnrecorded(client);
			await client.command({ query: "SYSTEM START MERGES logs" });
			await untilDone(client);
			const stored = await snapshot(client);
			await applyClickHouseMigrations(
				createClient(options),
				async (run) => run(),
				{ logsWriterMaintenance: true, metricsWriterMaintenance: true },
			);
			expect(await mutations(client)).toHaveLength(1);
			expect(await snapshot(client)).toEqual(stored);
		} finally {
			await client.command({ query: "SYSTEM START MERGES logs" });
			await untilDone(client);
		}
	});
}, 30_000);

test("0012 refuses a failed pending mutation without recording success or submitting more work", async () => {
	await withPopulatedPreview(async (client, options) => {
		await client.command({ query: uuidStatements()[0]! });
		try {
			await client.command({
				query:
					"ALTER TABLE logs UPDATE physical_row_id = toUUID(log_id) WHERE 1 SETTINGS mutations_sync = 0",
			});
			const deadline = Date.now() + 10_000;
			while (true) {
				const result = await client.query({
					query:
						"SELECT count() AS failed FROM system.mutations WHERE database = currentDatabase() AND table = 'logs' AND is_done = 0 AND latest_fail_reason != ''",
					format: "JSONEachRow",
				});
				if (Number((await result.json<{ failed: string }>())[0]!.failed) > 0)
					break;
				if (Date.now() >= deadline)
					throw new Error("Fixture mutation did not fail");
				await Bun.sleep(50);
			}
			await expect(
				applyClickHouseMigrations(createClient(options), async (run) => run(), {
					logsWriterMaintenance: true,
					metricsWriterMaintenance: true,
				}),
			).rejects.toThrow("Unfinished ClickHouse log mutation has failed");
			expect(await mutations(client)).toHaveLength(1);
			await expectUnrecorded(client);
		} finally {
			await client.command({
				query:
					"KILL MUTATION WHERE database = currentDatabase() AND table = 'logs'",
			});
		}
	});
}, 30_000);

for (const invalid of ["non-v4", "duplicated"] as const) {
	test(`0012 rejects stored ${invalid} UUIDs without replacing them or recording success`, async () => {
		await withPopulatedPreview(async (client, options) => {
			await client.command({ query: uuidStatements()[0]! });
			await client.command({
				query:
					invalid === "non-v4"
						? "ALTER TABLE logs UPDATE physical_row_id = if(log_id = 'foreign-org', toUUID('00000000-0000-1000-8000-000000000001'), generateUUIDv4()) WHERE 1 SETTINGS mutations_sync = 2"
						: "ALTER TABLE logs UPDATE physical_row_id = {id:UUID} WHERE 1 SETTINGS mutations_sync = 2",
				query_params: { id: randomUUID() },
			});
			const stored = await snapshot(client);
			const before = await mutations(client);
			await expect(
				applyClickHouseMigrations(createClient(options), async (run) => run(), {
					logsWriterMaintenance: true,
					metricsWriterMaintenance: true,
				}),
			).rejects.toThrow(
				"Physical log UUID backfill is incomplete or contains duplicated scoped IDs",
			);
			expect(await snapshot(client)).toEqual(stored);
			expect(await mutations(client)).toEqual(before);
			await expectUnrecorded(client);
		});
	}, 30_000);
}

test("0012 refuses an existing installation without drained-writer maintenance acknowledgement", async () => {
	await withPopulatedPreview(async (client, options) => {
		await expect(
			applyClickHouseMigrations(createClient(options), async (run) => run(), {
				logsWriterMaintenance: false,
			}),
		).rejects.toThrow("GLASSHOUSE_LOG_UUID_MAINTENANCE=1");
		const columns = await client.query({
			query:
				"SELECT name FROM system.columns WHERE database = currentDatabase() AND table = 'logs' AND name = 'physical_row_id'",
			format: "JSONEachRow",
		});
		expect(await columns.json()).toEqual([]);
		const rows = await client.query({
			query: "SELECT count() AS total FROM logs",
			format: "JSONEachRow",
		});
		expect(Number((await rows.json<{ total: string }>())[0]?.total)).toBe(6);
	});
}, 60_000);

for (const interruptedAt of [
	"after-add",
	"partial-backfill",
	"before-ledger",
] as const) {
	test(`0012 preserves populated preview rows and stored UUIDs after ${interruptedAt} interruption, replay and startup`, async () => {
		const migration = uuidMigration();
		await withPopulatedPreview(async (client, options, database) => {
			const legacy = await client.query({
				query: "SELECT * FROM logs",
				format: "JSONEachRow",
			});
			const originalPayloads = payloads(
				await legacy.json<Record<string, unknown>>(),
			);
			const runner = createClient(options);
			const exec = runner.exec.bind(runner);
			let added = false;
			let interrupted = false;
			const injection = spyOn(runner, "exec").mockImplementation(
				async (request) => {
					if (
						(interruptedAt !== "before-ledger" && added) ||
						(interruptedAt === "before-ledger" &&
							request.query_params?.migration === migration)
					) {
						interrupted = true;
						throw new Error("synthetic migration interruption");
					}
					const result = await exec(request);
					if (/ADD COLUMN[\s\S]*physical_row_id/.test(request.query))
						added = true;
					return result;
				},
			);
			try {
				await expect(
					applyClickHouseMigrations(runner, async (run) => run(), {
						logsWriterMaintenance: true,
						metricsWriterMaintenance: true,
					}),
				).rejects.toThrow("synthetic migration interruption");
			} finally {
				injection.mockRestore();
			}
			expect(interrupted).toBe(true);
			const ledger = await client.query({
				query:
					"SELECT migration FROM glasshouse_schema_migrations WHERE migration = {migration:String}",
				query_params: { migration },
				format: "JSONEachRow",
			});
			expect(await ledger.json()).toEqual([]);
			// A restarted old binary cannot keep adding unmaterialized/default IDs.
			await expect(
				client.command({
					query:
						"INSERT INTO logs (log_id, organization_id, project_id, ingested_time_unix_nano) VALUES ('old-writer', 'legacy-org', 'legacy-project', 1700000000000000000)",
				}),
			).rejects.toThrow(/logs_physical_row_id_v4/);
			const filledId = randomUUID();
			if (interruptedAt === "partial-backfill")
				await client.command({
					query:
						"ALTER TABLE logs UPDATE physical_row_id = {filledId:UUID} WHERE log_id = {logId:String} SETTINGS mutations_sync = 1",
					query_params: { filledId, logId: "b".repeat(64) },
				});
			const completedBeforeLedger =
				interruptedAt === "before-ledger" ? await snapshot(client) : undefined;
			await applyClickHouseMigrations(
				createClient(options),
				async (run) => run(),
				{ logsWriterMaintenance: true, metricsWriterMaintenance: true },
			);
			const before = await snapshot(client);
			expect(before).toHaveLength(6);
			expect(payloads(before)).toEqual(originalPayloads);
			for (const row of before) expect(row.physical_row_id).toMatch(uuidV4);
			expect(new Set(before.map((row) => row.physical_row_id)).size).toBe(6);
			expect(
				before.filter(
					(row) => row.body === '{"stringValue":"legacy-duplicate"}',
				),
			).toHaveLength(4);
			if (completedBeforeLedger) expect(before).toEqual(completedBeforeLedger);
			if (interruptedAt === "partial-backfill")
				expect(
					before.find((row) => row.log_id === "b".repeat(64))?.physical_row_id,
				).toBe(filledId);
			const missing = await client.query({
				query:
					"SELECT name FROM system.parts WHERE database = {database:String} AND table = 'logs' AND active AND name NOT IN (SELECT name FROM system.parts_columns WHERE database = {database:String} AND table = 'logs' AND active AND column = 'physical_row_id' AND ((part_type = 'Wide' AND column_bytes_on_disk > 0) OR (part_type = 'Compact' AND data_compressed_bytes > 0 AND marks_bytes > 0)))",
				query_params: { database },
				format: "JSONEachRow",
			});
			expect(await missing.json()).toEqual([]);
			expect(await snapshot(client)).toEqual(before);
			await applyClickHouseMigrations(createClient(options), async (run) =>
				run(),
			);
			await client.command({
				query:
					"OPTIMIZE TABLE logs FINAL SETTINGS optimize_skip_merged_partitions = 0",
			});
			expect(await snapshot(client)).toEqual(before);
		});
	}, 60_000);
}

for (const partType of ["Compact", "Wide"] as const) {
	test(`0012 recovers mixed materialized and legacy ${partType} parts without replacing stored UUIDs`, async () => {
		await withPopulatedPreview(async (client, options) => {
			const storedId = randomUUID();
			await client.command({ query: "SYSTEM STOP MERGES logs" });
			try {
				await client.command({ query: uuidStatements()[0]! });
				await client.command({
					query:
						"INSERT INTO logs (log_id, organization_id, project_id, ingested_time_unix_nano, physical_row_id) VALUES ('stored-before-replay', 'legacy-org', 'legacy-project', 1700000000000000000, {id:UUID})",
					query_params: { id: storedId },
					clickhouse_settings: { async_insert: 0 },
				});
				const result = await client.query({
					query:
						"SELECT count() AS total, countIf(name IN (SELECT name FROM system.parts_columns WHERE database = currentDatabase() AND table = 'logs' AND active AND column = 'physical_row_id')) AS stored FROM system.parts WHERE database = currentDatabase() AND table = 'logs' AND active AND rows > 0",
					format: "JSONEachRow",
				});
				const [parts] = await result.json<{ total: string; stored: string }>();
				expect(Number(parts!.stored)).toBe(1);
				expect(Number(parts!.total)).toBeGreaterThan(1);
				await expect(
					client.command({ query: uuidStatements()[4]! }),
				).rejects.toThrow(
					"Physical log UUID column is not stored in every populated active part",
				);
			} finally {
				await client.command({ query: "SYSTEM START MERGES logs" });
			}
			await applyClickHouseMigrations(
				createClient(options),
				async (run) => run(),
				{ logsWriterMaintenance: true, metricsWriterMaintenance: true },
			);
			const rows = await snapshot(client);
			expect(rows).toHaveLength(7);
			for (const row of rows) expect(row.physical_row_id).toMatch(uuidV4);
			expect(
				rows.find((row) => row.log_id === "stored-before-replay")
					?.physical_row_id,
			).toBe(storedId);
			await client.command({ query: uuidStatements()[4]! });
		}, partType);
	}, 30_000);

	test(`0012 rejects unmaterialized ${partType} parts and preserves stored UUIDs through backfill, replay and startup`, async () => {
		const migration = uuidMigration();
		const statements = readFileSync(new URL(migration, directory), "utf8")
			.replace(/^--.*$/gm, "")
			.split(";")
			.map((statement) => statement.trim())
			.filter(Boolean);
		expect(statements).toHaveLength(5);
		const add = statements[0]!;
		const backfill = statements[2]!;
		const physicalCheck = statements[4]!;
		const missingId = "00000000-0000-0000-0000-000000000000";
		expect(add).toContain("ADD COLUMN IF NOT EXISTS physical_row_id");
		expect(backfill).toContain("UPDATE physical_row_id");
		expect(physicalCheck).toContain("FROM system.parts WHERE");
		await withPopulatedPreview(async (client, options, database) => {
			// One part prevents a background merge from materializing ADD's default.
			await client.command({
				query:
					"OPTIMIZE TABLE logs FINAL SETTINGS optimize_skip_merged_partitions = 0",
			});
			const expectPhysicalPart = async () => {
				const result = await client.query({
					query:
						"SELECT name, part_type, rows, data_compressed_bytes, marks_bytes FROM system.parts WHERE database = {database:String} AND table = 'logs' AND active ORDER BY name",
					query_params: { database },
					format: "JSONEachRow",
				});
				const parts = await result.json<{
					name: string;
					part_type: string;
					rows: string;
					data_compressed_bytes: string;
					marks_bytes: string;
				}>();
				expect(parts).toHaveLength(1);
				const part = parts[0]!;
				expect(part.part_type).toBe(partType);
				expect(Number(part.rows)).toBe(6);
				expect(Number(part.data_compressed_bytes)).toBeGreaterThan(0);
				expect(Number(part.marks_bytes)).toBeGreaterThan(0);
				return part.name;
			};
			const expectStoredColumn = async () => {
				const partName = await expectPhysicalPart();
				const result = await client.query({
					query:
						"SELECT name, part_type, column_bytes_on_disk, column_data_compressed_bytes, column_data_uncompressed_bytes, column_marks_bytes, data_compressed_bytes, marks_bytes FROM system.parts_columns WHERE database = {database:String} AND table = 'logs' AND active AND column = 'physical_row_id' ORDER BY name",
					query_params: { database },
					format: "JSONEachRow",
				});
				const columns = await result.json<{
					name: string;
					part_type: string;
					column_bytes_on_disk: string;
					column_data_compressed_bytes: string;
					column_data_uncompressed_bytes: string;
					column_marks_bytes: string;
					data_compressed_bytes: string;
					marks_bytes: string;
				}>();
				expect(columns).toHaveLength(1);
				const column = columns[0]!;
				expect(column.name).toBe(partName);
				expect(column.part_type).toBe(partType);
				expect(Number(column.data_compressed_bytes)).toBeGreaterThan(0);
				expect(Number(column.marks_bytes)).toBeGreaterThan(0);
				if (partType === "Wide") {
					expect(Number(column.column_bytes_on_disk)).toBeGreaterThan(0);
				} else {
					expect(Number(column.column_bytes_on_disk)).toBe(0);
					expect(Number(column.column_data_compressed_bytes)).toBe(0);
					expect(Number(column.column_data_uncompressed_bytes)).toBe(0);
					expect(Number(column.column_marks_bytes)).toBe(0);
				}
				await client.command({ query: physicalCheck });
			};
			await expectPhysicalPart();
			const legacy = await client.query({
				query: "SELECT * FROM logs",
				format: "JSONEachRow",
			});
			const originalPayloads = payloads(
				await legacy.json<Record<string, unknown>>(),
			);
			await client.command({ query: add });
			await expectPhysicalPart();
			const unmaterialized = await client.query({
				query:
					"SELECT name FROM system.parts_columns WHERE database = {database:String} AND table = 'logs' AND active AND column = 'physical_row_id'",
				query_params: { database },
				format: "JSONEachRow",
			});
			expect(await unmaterialized.json()).toEqual([]);
			const afterAdd = await snapshot(client);
			expect(afterAdd).toHaveLength(6);
			expect(payloads(afterAdd)).toEqual(originalPayloads);
			for (const row of afterAdd) expect(row.physical_row_id).toBe(missingId);
			await expect(client.command({ query: physicalCheck })).rejects.toThrow(
				"Physical log UUID column is not stored in every populated active part",
			);
			const filledId = randomUUID();
			await client.command({
				query:
					"ALTER TABLE logs UPDATE physical_row_id = {filledId:UUID} WHERE log_id = {logId:String} SETTINGS mutations_sync = 2",
				query_params: { filledId, logId: "b".repeat(64) },
			});
			const partiallyFilled = await snapshot(client);
			expect(
				partiallyFilled.filter((row) => row.physical_row_id === filledId),
			).toHaveLength(1);
			expect(
				partiallyFilled.filter((row) => row.physical_row_id === missingId),
			).toHaveLength(5);
			await client.command({ query: backfill });
			await untilDone(client);
			await expectStoredColumn();
			const beforeReplay = await snapshot(client);
			expect(beforeReplay).toHaveLength(6);
			expect(payloads(beforeReplay)).toEqual(originalPayloads);
			for (const row of beforeReplay)
				expect(row.physical_row_id).toMatch(uuidV4);
			expect(new Set(beforeReplay.map((row) => row.physical_row_id)).size).toBe(
				6,
			);
			expect(
				beforeReplay.find((row) => row.log_id === "b".repeat(64))
					?.physical_row_id,
			).toBe(filledId);
			const ledger = await client.query({
				query:
					"SELECT migration FROM glasshouse_schema_migrations WHERE migration = {migration:String}",
				query_params: { migration },
				format: "JSONEachRow",
			});
			expect(await ledger.json()).toEqual([]);
			await applyClickHouseMigrations(
				createClient(options),
				async (run) => run(),
				{ logsWriterMaintenance: true, metricsWriterMaintenance: true },
			);
			expect(await snapshot(client)).toEqual(beforeReplay);
			await expectStoredColumn();
			await applyClickHouseMigrations(
				createClient(options),
				async (run) => run(),
				{ logsWriterMaintenance: false },
			);
			expect(await snapshot(client)).toEqual(beforeReplay);
			await expectStoredColumn();
			await client.command({
				query:
					"OPTIMIZE TABLE logs FINAL SETTINGS optimize_skip_merged_partitions = 0",
			});
			await expectStoredColumn();
			expect(await snapshot(client)).toEqual(beforeReplay);
		}, partType);
	}, 60_000);
}
