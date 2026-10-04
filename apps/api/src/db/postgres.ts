import { Pool } from "pg";

let _pool: Pool | null = null;
let _authenticationPool: Pool | null = null;

// Request fences must not exhaust the connections borrowed by repositories.
export function authenticationPool(): Pool {
	return (_authenticationPool ??= new Pool({
		connectionString: postgresUrl(),
		max: 10,
		idleTimeoutMillis: 30_000,
	}));
}

export function postgresUrl(): string {
	// Fall back to component vars so a missing DATABASE_URL doesn't drop the password.
	return (
		process.env.DATABASE_URL ??
		`postgres://${process.env.POSTGRES_USER ?? "postgres"}:${process.env.POSTGRES_PASSWORD ?? "postgres"}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB ?? "postgres"}`
	);
}

export function pgPool(): Pool {
	if (_pool) return _pool;
	_pool = new Pool({
		connectionString: postgresUrl(),
		max: 5,
		idleTimeoutMillis: 30_000,
	});
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
