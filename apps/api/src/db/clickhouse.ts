// ClickHouse client + ping helper for /health.

import { createClient, type ClickHouseClient } from "@clickhouse/client";

let _client: ClickHouseClient | null = null;

export function ch(): ClickHouseClient {
  if (_client) return _client;
  _client = createClient({
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
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