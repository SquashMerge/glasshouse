import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ch, closeClickHouseClient } from "../../src/db/clickhouse";
import { pgPool } from "../../src/db/postgres";
import { valkey } from "../../src/db/valkey";

const verifyVersions = process.env.GLASSHOUSE_VERIFY_DATASTORE_VERSIONS === "1";

afterAll(async () => {
	valkey().disconnect();
	await Promise.all([pgPool().end(), closeClickHouseClient()]);
});

test("the application PostgreSQL client supports transactions, JSONB and advisory locks", async () => {
	const client = await pgPool().connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"CREATE TEMP TABLE datastore_probe (id uuid PRIMARY KEY, payload jsonb NOT NULL) ON COMMIT DROP",
		);
		const id = randomUUID();
		await client.query("INSERT INTO datastore_probe VALUES ($1, $2::jsonb)", [
			id,
			JSON.stringify({ value: "round-trip" }),
		]);
		const result = await client.query(
			"SELECT payload->>'value' AS value, pg_try_advisory_xact_lock(43) AS locked FROM datastore_probe WHERE id = $1",
			[id],
		);
		expect(result.rows).toEqual([{ value: "round-trip", locked: true }]);
		const version = await client.query("SHOW server_version");
		if (verifyVersions)
			expect(version.rows[0].server_version).toMatch(/^18\.6(?:\D|$)/);
	} finally {
		await client.query("ROLLBACK");
		client.release();
	}
});

test("the application ClickHouse HTTP client supports typed parameters and JSONEachRow", async () => {
	const result = await ch().query({
		query:
			"SELECT version() AS version, {scope:String} AS scope, map('value', 'round-trip')['value'] AS value, toUnixTimestamp64Milli(toDateTime64('2026-10-30 00:00:00', 3, 'UTC')) AS timestamp",
		query_params: { scope: "datastore-connectivity" },
		format: "JSONEachRow",
	});
	const [row] = await result.json<{
		version: string;
		scope: string;
		value: string;
		timestamp: string;
	}>();
	expect(row.scope).toBe("datastore-connectivity");
	expect(row.value).toBe("round-trip");
	expect(Number(row.timestamp)).toBe(Date.UTC(2026, 9, 30));
	if (verifyVersions) expect(row.version).toBe("26.10.2.103");
});

test("the application ioredis client authenticates and delivers Valkey pub/sub", async () => {
	const publisher = valkey();
	if (publisher.status === "wait") await publisher.connect();
	expect(await publisher.ping()).toBe("PONG");
	const info = await publisher.info("server");
	if (verifyVersions) expect(info).toMatch(/^valkey_version:9\.1\.3\r?$/m);
	const subscriber = publisher.duplicate({ lazyConnect: true });
	const channel = `glasshouse:datastore-probe:${randomUUID()}`;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await subscriber.connect();
		await subscriber.subscribe(channel);
		const received = new Promise<string>((resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error("Valkey pub/sub delivery timed out")),
				3000,
			);
			subscriber.once("message", (actualChannel, message) => {
				expect(actualChannel).toBe(channel);
				resolve(message);
			});
		});
		await publisher.publish(channel, "round-trip");
		expect(await received).toBe("round-trip");
	} finally {
		clearTimeout(timer);
		subscriber.disconnect();
	}
});
