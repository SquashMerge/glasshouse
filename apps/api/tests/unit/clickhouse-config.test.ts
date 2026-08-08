import { afterEach, describe, expect, it } from "bun:test";
import { clickhouseUrl } from "../../src/db/clickhouse";

const originalUrl = process.env.CLICKHOUSE_URL;
const originalHost = process.env.CLICKHOUSE_HOST;
const originalPort = process.env.CLICKHOUSE_HTTP_PORT;

afterEach(() => {
	process.env.CLICKHOUSE_URL = originalUrl;
	process.env.CLICKHOUSE_HOST = originalHost;
	process.env.CLICKHOUSE_HTTP_PORT = originalPort;
});

describe("ClickHouse connection configuration", () => {
	it("uses the configured host HTTP port when no URL override is supplied", () => {
		delete process.env.CLICKHOUSE_URL;
		process.env.CLICKHOUSE_HOST = "localhost";
		process.env.CLICKHOUSE_HTTP_PORT = "18123";

		expect(clickhouseUrl()).toBe("http://localhost:18123");
	});
});
