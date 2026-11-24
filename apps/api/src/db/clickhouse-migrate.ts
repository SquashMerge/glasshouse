import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { addAbortSignal } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { Client } from "pg";
import { clickhouseUrl } from "./clickhouse.js";
import { postgresUrl } from "./postgres.js";
import { logger } from "../lib/logger.js";

const migrationsDirectory = fileURLToPath(
	new URL("../../../../infra/db/clickhouse/", import.meta.url),
);
const migrationTable = "glasshouse_schema_migrations";
const migrationLockName = "glasshouse.clickhouse-schema-migrations";
const logsUuidMigration = "0012_logs_physical_uuid.sql";
const metricsUuidMigration = "0013_metrics_physical_uuid.sql";

function logsUuidTimeoutMs(
	value: string | number | undefined = process.env
		.GLASSHOUSE_LOG_UUID_TIMEOUT_MS,
) {
	const timeout = Number(value ?? 300_000);
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3_600_000)
		throw new Error(
			"GLASSHOUSE_LOG_UUID_TIMEOUT_MS must be an integer from 1 to 3600000",
		);
	return timeout;
}

// Client 1.24.1 detaches command/query abort listeners at headers. Own response
// cancellation through consumption, and await settlement before releasing the lock.
async function logsUuidCommand(
	client: ClickHouseClient,
	request: Parameters<ClickHouseClient["command"]>[0],
	abort_signal: AbortSignal,
) {
	abort_signal.throwIfAborted();
	const { stream } = await client.exec({
		...request,
		abort_signal,
		clickhouse_settings: { wait_end_of_query: 1 },
	});
	await finished(addAbortSignal(abort_signal, stream).resume(), {
		cleanup: true,
	});
	abort_signal.throwIfAborted();
}

async function logsUuidQuery<T>(
	client: ClickHouseClient,
	query: string,
	abort_signal: AbortSignal,
) {
	abort_signal.throwIfAborted();
	const result = await client.query({
		query,
		format: "JSONEachRow",
		abort_signal,
	});
	const onAbort = () => result.close();
	abort_signal.addEventListener("abort", onAbort, { once: true });
	try {
		if (abort_signal.aborted) onAbort();
		const rows = await result.json<T>();
		abort_signal.throwIfAborted();
		return rows;
	} finally {
		abort_signal.removeEventListener("abort", onAbort);
	}
}

async function waitForLogMutations(
	client: ClickHouseClient,
	abort_signal: AbortSignal,
	table: "logs" | "metrics" = "logs",
) {
	while (true) {
		const [state] = await logsUuidQuery<{ pending: string; failed: string }>(
			client,
			`SELECT count() AS pending, countIf(latest_fail_reason != '') AS failed FROM system.mutations WHERE database = currentDatabase() AND table = '${table}' AND is_done = 0`,
			abort_signal,
		);
		if (!state)
			throw new Error(
				`Missing ClickHouse ${table === "logs" ? "log" : "metric"} mutation status`,
			);
		if (Number(state.failed) > 0)
			throw new Error(
				`Unfinished ClickHouse ${table === "logs" ? "log" : "metric"} mutation has failed. Keep writers drained, inspect system.mutations and repair before retrying ${table === "logs" ? "0012" : "0013"}.`,
			);
		if (Number(state.pending) === 0) return;
		await delay(1_000, undefined, { signal: abort_signal });
	}
}

async function applyLogsUuidMigration(
	client: ClickHouseClient,
	statements: string[],
	abort_signal: AbortSignal,
	table: "logs" | "metrics" = "logs",
) {
	if (statements.length !== 5)
		throw new Error(
			`Unexpected ClickHouse ${table === "logs" ? "0012" : "0013"} statement layout`,
		);
	const [add, probe, backfill, logicalCheck, physicalCheck] = statements as [
		string,
		string,
		string,
		string,
		string,
	];
	const command = (query: string) =>
		logsUuidCommand(client, { query }, abort_signal);
	// A timed-out request can leave a durable mutation running after lock release.
	await waitForLogMutations(client, abort_signal, table);
	await command(add);
	const rows = await logsUuidQuery<{ needs_backfill: number }>(
		client,
		probe,
		abort_signal,
	);
	if (rows.length !== 1 || ![0, 1].includes(rows[0]!.needs_backfill))
		throw new Error(
			`Invalid ClickHouse ${table === "logs" ? "log" : "metric"} UUID backfill status`,
		);
	if (rows[0]!.needs_backfill === 1) {
		await command(backfill);
		await waitForLogMutations(client, abort_signal, table);
	}
	await command(logicalCheck);
	await command(physicalCheck);
}

type AppliedMigration = {
	migration: string;
	checksum: string;
};

type MigrationLock = <T>(run: () => Promise<T>) => Promise<T>;

type MigrationLockClient = Pick<Client, "connect" | "query" | "end">;

export async function withClickHouseMigrationLock<T>(
	run: () => Promise<T>,
	createLockClient: () => MigrationLockClient = () =>
		new Client({ connectionString: postgresUrl() }),
): Promise<T> {
	const lockClient = createLockClient();
	let acquired = false;
	await lockClient.connect();
	try {
		await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [
			migrationLockName,
		]);
		acquired = true;
		return await run();
	} finally {
		try {
			if (acquired)
				await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [
					migrationLockName,
				]);
		} finally {
			await lockClient.end();
		}
	}
}

function migrationFiles(): string[] {
	return readdirSync(migrationsDirectory)
		.filter((file) => /^\d+_.+\.sql$/.test(file))
		.sort();
}

function checksum(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

async function appliedMigrations(
	client: ClickHouseClient,
): Promise<Map<string, string>> {
	await client.command({
		query: `CREATE TABLE IF NOT EXISTS ${migrationTable} (migration String, checksum String, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY migration`,
	});
	const result = await client.query({
		query: `SELECT migration, checksum FROM ${migrationTable}`,
		format: "JSONEachRow",
	});
	return new Map(
		(await result.json<AppliedMigration>()).map(({ migration, checksum }) => [
			migration,
			checksum,
		]),
	);
}

export async function applyClickHouseMigrations(
	client: ClickHouseClient = createClient({
		url: clickhouseUrl(),
		database: process.env.CLICKHOUSE_DB ?? "glasshouse",
		username: process.env.CLICKHOUSE_USER ?? "glasshouse",
		password: process.env.CLICKHOUSE_PASSWORD ?? "",
		request_timeout: logsUuidTimeoutMs(),
	}),
	withMigrationLock: MigrationLock = withClickHouseMigrationLock,
	options: {
		logsWriterMaintenance?: boolean;
		metricsWriterMaintenance?: boolean;
		logsUuidTimeoutMs?: number;
	} = {
		logsWriterMaintenance: process.env.GLASSHOUSE_LOG_UUID_MAINTENANCE === "1",
		metricsWriterMaintenance:
			process.env.GLASSHOUSE_METRIC_UUID_MAINTENANCE === "1",
	},
): Promise<void> {
	try {
		await withMigrationLock(async () => {
			const applied = await appliedMigrations(client);
			for (const file of migrationFiles()) {
				const source = readFileSync(`${migrationsDirectory}/${file}`, "utf8");
				const migrationChecksum = checksum(source);
				const previousChecksum = applied.get(file);
				if (previousChecksum) {
					if (previousChecksum !== migrationChecksum)
						throw new Error(`ClickHouse migration checksum changed: ${file}`);
					logger.info("clickhouse.migration.skipped", { migration: file });
					continue;
				}
				if (
					file === logsUuidMigration &&
					applied.has("0009_otlp_logs.sql") &&
					!options.logsWriterMaintenance
				)
					throw new Error(
						"ClickHouse log UUID upgrade requires maintenance: stop and drain all log writers and in-flight inserts, then set GLASSHOUSE_LOG_UUID_MAINTENANCE=1 for this migration run. Rolling upgrades are unsupported.",
					);
				if (
					file === metricsUuidMigration &&
					applied.has("0010_otlp_metrics.sql") &&
					!options.metricsWriterMaintenance
				)
					throw new Error(
						"ClickHouse metric UUID upgrade requires maintenance: stop and drain all metric writers and in-flight inserts, then set GLASSHOUSE_METRIC_UUID_MAINTENANCE=1 for this migration run. Rolling upgrades are unsupported.",
					);
				const statements = source
					.replace(/^--.*$/gm, "")
					.split(";")
					.map((statement) => statement.trim())
					.filter((statement) => statement.length > 0);
				const record = async (abort_signal?: AbortSignal) => {
					const request = {
						query: `INSERT INTO ${migrationTable} (migration, checksum) VALUES ({migration:String}, {checksum:String})`,
						query_params: { migration: file, checksum: migrationChecksum },
					};
					if (abort_signal)
						await logsUuidCommand(client, request, abort_signal);
					else
						await client.command({
							...request,
							clickhouse_settings: { wait_end_of_query: 1 },
						});
				};
				if (file === logsUuidMigration || file === metricsUuidMigration) {
					const table = file === logsUuidMigration ? "logs" : "metrics";
					const timeout = logsUuidTimeoutMs(options.logsUuidTimeoutMs);
					const controller = new AbortController();
					const timer = setTimeout(
						() =>
							controller.abort(
								new Error(
									file === logsUuidMigration
										? "ClickHouse 0012 deadline exceeded. Its mutation may continue in the background. Keep writers drained and rerun with GLASSHOUSE_LOG_UUID_MAINTENANCE=1 to resume."
										: "ClickHouse 0013 deadline exceeded. Its mutation may continue in the background. Keep writers drained and rerun with GLASSHOUSE_METRIC_UUID_MAINTENANCE=1 to resume.",
								),
							),
						timeout,
					);
					try {
						await applyLogsUuidMigration(
							client,
							statements,
							controller.signal,
							table,
						);
						await record(controller.signal);
						controller.signal.throwIfAborted();
					} catch (error) {
						if (controller.signal.aborted) throw controller.signal.reason;
						throw error;
					} finally {
						clearTimeout(timer);
					}
				} else {
					for (const query of statements) await client.command({ query });
					await record();
				}
				logger.info("clickhouse.migration.applied", { migration: file });
			}
		});
	} finally {
		await client.close();
	}
}

if (import.meta.main) await applyClickHouseMigrations();
