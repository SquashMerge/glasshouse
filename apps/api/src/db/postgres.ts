import { Pool } from "pg";

let _pool: Pool | null = null;

export function pgPool(): Pool {
  if (_pool) return _pool;
  // Fall back to component vars so a missing DATABASE_URL doesn't drop the password.
  const url =
    process.env.DATABASE_URL ??
    `postgres://${process.env.POSTGRES_USER ?? "postgres"}:${process.env.POSTGRES_PASSWORD ?? "postgres"}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB ?? "postgres"}`;
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