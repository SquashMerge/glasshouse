import { createClient, type ClickHouseClient } from "@clickhouse/client";

let _client: ClickHouseClient | null = null;

export function clickhouseUrl(): string {
	return (
		process.env.CLICKHOUSE_URL ??
		`http://${process.env.CLICKHOUSE_HOST ?? "localhost"}:${process.env.CLICKHOUSE_HTTP_PORT ?? "8123"}`
	);
}

export function ch(): ClickHouseClient {
	if (_client) return _client;
	_client = createClient({
		url: clickhouseUrl(),
		database: process.env.CLICKHOUSE_DB ?? "astraea",
		username: process.env.CLICKHOUSE_USER ?? "astraea",
		password: process.env.CLICKHOUSE_PASSWORD ?? "",
	});
	return _client;
}

export async function chPing(): Promise<"up" | "down"> {
	try {
		const c = ch();
		const result = await c.ping();
		return result.success ? "up" : "down";
	} catch {
		return "down";
	}
}
