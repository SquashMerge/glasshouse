import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger.js";

const migrationsDirectory = fileURLToPath(
	new URL("../../../../infra/db/clickhouse/", import.meta.url),
);

function migrationFiles(): string[] {
	return readdirSync(migrationsDirectory)
		.filter((file) => /^\d+_.+\.sql$/.test(file))
		.sort();
}

export async function applyClickHouseMigrations(
	client: ClickHouseClient = createClient({
		url:
			process.env.CLICKHOUSE_URL ??
			`http://${process.env.CLICKHOUSE_HOST ?? "localhost"}:8123`,
		database: process.env.CLICKHOUSE_DB ?? "astraea",
		username: process.env.CLICKHOUSE_USER ?? "astraea",
		password: process.env.CLICKHOUSE_PASSWORD ?? "",
	}),
): Promise<void> {
	try {
		for (const file of migrationFiles()) {
			const statements = readFileSync(`${migrationsDirectory}/${file}`, "utf8")
				.replace(/^--.*$/gm, "")
				.split(";")
				.map((statement) => statement.trim())
				.filter((statement) => statement.length > 0);
			for (const query of statements) await client.command({ query });
			logger.info("clickhouse.migration.applied", { migration: file });
		}
	} finally {
		await client.close();
	}
}

if (import.meta.main) await applyClickHouseMigrations();
