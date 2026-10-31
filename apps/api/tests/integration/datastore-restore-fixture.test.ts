import { expect, test } from "bun:test";
import { createClient } from "@clickhouse/client";
import { Pool } from "pg";
import { clickhouseUrl } from "../../src/db/clickhouse";
import { postgresUrl } from "../../src/db/postgres";

test("the restore application fixture seeds and replays full migration ledgers in disposable databases", async () => {
	const name = `datastore_fixture_${crypto.randomUUID().replaceAll("-", "")}`;
	const postgres = new Pool({ connectionString: postgresUrl() });
	const clickhouse = createClient({
		url: clickhouseUrl(),
		username: process.env.CLICKHOUSE_USER ?? "glasshouse",
		password: process.env.CLICKHOUSE_PASSWORD ?? "",
	});
	const databaseUrl = new URL(postgresUrl());
	databaseUrl.pathname = `/${name}`;
	try {
		await postgres.query(`CREATE DATABASE ${name}`);
		await clickhouse.command({ query: `CREATE DATABASE ${name}` });
		for (const mode of ["seed", "verify"]) {
			const child = Bun.spawn(
				[
					"bun",
					"run",
					new URL("../fixtures/datastore-restore.ts", import.meta.url).pathname,
					mode,
				],
				{
					env: {
						...process.env,
						DATABASE_URL: databaseUrl.toString(),
						CLICKHOUSE_URL: clickhouseUrl(),
						CLICKHOUSE_DB: name,
						BACKUP_RESTORE_APPLICATION_FIXTURE: "1",
					},
					stdout: "ignore",
					stderr: "inherit",
				},
			);
			expect(await child.exited).toBe(0);
		}
	} finally {
		try {
			await clickhouse.command({
				query: `DROP DATABASE IF EXISTS ${name} SYNC`,
			});
			await postgres.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
		} finally {
			await Promise.all([postgres.end(), clickhouse.close()]);
		}
	}
}, 120_000);
