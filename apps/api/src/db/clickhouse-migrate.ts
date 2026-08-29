import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { Client } from "pg";
import { clickhouseUrl } from "./clickhouse.js";
import { postgresUrl } from "./postgres.js";
import { logger } from "../lib/logger.js";

const migrationsDirectory = fileURLToPath(
	new URL("../../../../infra/db/clickhouse/", import.meta.url),
);
const migrationTable = "astraea_schema_migrations";
const migrationLockName = "astraea.clickhouse-schema-migrations";

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
		if (acquired)
			await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [
				migrationLockName,
			]);
		await lockClient.end();
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
		database: process.env.CLICKHOUSE_DB ?? "astraea",
		username: process.env.CLICKHOUSE_USER ?? "astraea",
		password: process.env.CLICKHOUSE_PASSWORD ?? "",
	}),
	withMigrationLock: MigrationLock = withClickHouseMigrationLock,
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
				const statements = source
					.replace(/^--.*$/gm, "")
					.split(";")
					.map((statement) => statement.trim())
					.filter((statement) => statement.length > 0);
				for (const query of statements) await client.command({ query });
				await client.command({
					query: `INSERT INTO ${migrationTable} (migration, checksum) VALUES ({migration:String}, {checksum:String})`,
					query_params: { migration: file, checksum: migrationChecksum },
				});
				logger.info("clickhouse.migration.applied", { migration: file });
			}
		});
	} finally {
		await client.close();
	}
}

if (import.meta.main) await applyClickHouseMigrations();
