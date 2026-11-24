import { expect, test } from "bun:test";
import { createClient } from "@clickhouse/client";
import { Client } from "pg";
import { otlpDisposableDatastores } from "../helpers/otlp-disposable-datastores.js";

const database = `otlp_extension_${"a".repeat(32)}`;
const safe = {
	GLASSHOUSE_CONTAINER_NETWORK: "1",
	POSTGRES_HOST: "postgres",
	POSTGRES_PORT: "5432",
	CLICKHOUSE_HOST: "clickhouse",
	CLICKHOUSE_HTTP_PORT: "8123",
};

function effectivePostgres(connectionString: string) {
	// Constructing Client parses the pinned driver configuration without connecting.
	return (
		new Client({ connectionString }) as unknown as {
			connectionParameters: {
				host: string;
				port: number;
				database: string;
				user: string;
				password: string;
			};
		}
	).connectionParameters;
}

async function effectiveClickhouse(
	options: Parameters<typeof createClient>[0],
) {
	const client = createClient(options);
	try {
		// Inspect the pinned driver's resolved config; never issue a request.
		return (
			client as unknown as {
				connectionParams: { database: string; url: URL };
			}
		).connectionParams;
	} finally {
		await client.close();
	}
}

test("pinned drivers prove URL overrides without opening connections", async () => {
	const pg = new URL(
		"postgres://test:synthetic@postgres:5432/postgres?host=unsafe-example.invalid&port=6543&database=not_owned",
	);
	expect(pg.hostname).toBe("postgres");
	expect(pg.port).toBe("5432");
	pg.pathname = `/${database}`;
	expect(effectivePostgres(pg.toString())).toMatchObject({
		host: "unsafe-example.invalid",
		port: 6543,
		database,
	});
	expect(
		(
			await effectiveClickhouse({
				url: "http://clickhouse:8123/not_owned",
				database,
			})
		).database,
	).toBe("not_owned");
});

for (const [key, value] of [
	["GLASSHOUSE_CONTAINER_NETWORK", undefined],
	["NODE_ENV", "production"],
	["POSTGRES_HOST", "unsafe-example.invalid"],
	["POSTGRES_PORT", "5432@unsafe-example.invalid:6543"],
	["CLICKHOUSE_HOST", "localhost"],
	["CLICKHOUSE_HTTP_PORT", "8123@unsafe-example.invalid:8123"],
	["DATABASE_URL", ""],
	["DATABASE_URL", "http://postgres:5432/postgres"],
	[
		"DATABASE_URL",
		"postgres://postgres:5432/postgres?host=unsafe-example.invalid",
	],
	["DATABASE_URL", "postgres://postgres:5432/postgres?port=6543"],
	["DATABASE_URL", "postgres://postgres:5432/postgres?database=not_owned"],
	[
		"DATABASE_URL",
		"postgres://postgres:5432/postgres?%68ost=unsafe-example.invalid",
	],
	["DATABASE_URL", "postgres://postgres:5432/postgres?sslcert=/not-owned"],
	["DATABASE_URL", "postgres://postgres:5432/postgres#ignored"],
	["DATABASE_URL", "postgres://postgres:5432/postgres?"],
	["DATABASE_URL", "postgres://postgres:5432/postgres#"],
	["DATABASE_URL", "postgres://%ZZ:synthetic@postgres:5432/postgres"],
	["DATABASE_URL", "postgres://postgres:5432/not_owned/other"],
	["CLICKHOUSE_URL", ""],
	["CLICKHOUSE_URL", "http://clickhouse/"],
	["CLICKHOUSE_URL", "https://clickhouse:8123/"],
	["CLICKHOUSE_URL", "http://clickhouse:8123/not_owned"],
	["CLICKHOUSE_URL", "http://clickhouse:8123/?database=not_owned"],
	["CLICKHOUSE_URL", "http://clickhouse:8123/?pathname=/not_owned"],
	["CLICKHOUSE_URL", "http://clickhouse:8123/?ch_readonly=0"],
	["CLICKHOUSE_URL", "http://clickhouse:8123/#ignored"],
	["CLICKHOUSE_URL", "http://clickhouse:8123/?"],
	["CLICKHOUSE_URL", "http://clickhouse:8123/%6eot_owned"],
	["CLICKHOUSE_URL", "http://clickhouse:8123/\\not_owned"],
	["CLICKHOUSE_URL", "http://clickhouse:8123/\n"],
	["PGHOST", "unsafe-example.invalid"],
	["PGPORT", "6543"],
	["PGOPTIONS", "-c search_path=not_owned"],
] as const) {
	test(`disposable config rejects ${key}=${value}`, () => {
		expect(() =>
			otlpDisposableDatastores({ ...safe, [key]: value }, database),
		).toThrow();
	});
}

test("all effective driver targets use only private services and the generated database", async () => {
	const config = otlpDisposableDatastores(
		{
			...safe,
			POSTGRES_USER: "fixture",
			POSTGRES_PASSWORD:
				"synthetic@unsafe-example.invalid:6543/?host=elsewhere#%",
			POSTGRES_DB: "not_owned?host=unsafe-example.invalid&port=6543",
			CLICKHOUSE_DB: "not_owned",
		},
		database,
	);
	expect(effectivePostgres(config.postgresAdminUrl)).toMatchObject({
		host: "postgres",
		port: 5432,
		database: "postgres",
		user: "fixture",
	});
	expect(effectivePostgres(config.postgresUrl)).toMatchObject({
		host: "postgres",
		port: 5432,
		database,
		user: "fixture",
		password: "synthetic@unsafe-example.invalid:6543/?host=elsewhere#%",
	});
	expect(
		(await effectiveClickhouse(config.clickhouseAdminOptions)).database,
	).toBe("default");
	const clickhouse = await effectiveClickhouse(config.clickhouseOptions);
	expect(clickhouse.database).toBe(database);
	expect(clickhouse.url.origin).toBe("http://clickhouse:8123");
});

test("safe explicit URLs cannot choose a non-generated test database", async () => {
	const config = otlpDisposableDatastores(
		{
			...safe,
			DATABASE_URL: "postgres://test:synthetic@postgres:5432/not_owned",
			CLICKHOUSE_URL: "http://clickhouse:8123/",
		},
		database,
	);
	expect(effectivePostgres(config.postgresAdminUrl).database).toBe("postgres");
	expect(effectivePostgres(config.postgresUrl).database).toBe(database);
	expect((await effectiveClickhouse(config.clickhouseOptions)).database).toBe(
		database,
	);
});

test("disposable config rejects non-owned database identifiers", () => {
	for (const name of [
		"postgres",
		"glasshouse",
		`${database}; DROP DATABASE postgres`,
		"otlp_extension_abc",
	])
		expect(() => otlpDisposableDatastores(safe, name)).toThrow();
});
