// Stub clients for Wave 1; upgraded to real wiring in Wave 2 (`db-schemas-and-clients`).
// These are exported with the same shape as the real clients so health.ts compiles
// before Wave 2 runs.

import { Pool } from "pg";

let _pool: Pool | null = null;

export function pgPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
  _pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 });
  return _pool;
}

export async function pgPing(): Promise<"up" | "down"> {
  try {
    const pool = pgPool();
    await pool.query("SELECT 1");
    return "up";
  } catch {
    return "down";
  }
}