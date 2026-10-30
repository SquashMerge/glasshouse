import { describe, expect, it } from "bun:test";
import type { Pool } from "pg";
import {
	LocalCredentialError,
	LocalCredentialStore,
} from "../../src/db/local-credentials";

function unusedPool() {
	let accessed = false;
	const pool = {
		connect: () => {
			accessed = true;
			throw new Error("database should not be accessed");
		},
	} as unknown as Pool;
	return { pool, wasAccessed: () => accessed };
}

describe("local credential password policy", () => {
	it("rejects a short first-admin password before database access", async () => {
		const database = unusedPool();
		const store = new LocalCredentialStore(
			database.pool,
			"00000000-0000-4000-8000-000000000001",
		);
		await expect(
			store.bootstrap({
				username: "test.admin",
				password: "short",
				token: "A".repeat(43),
			}),
		).rejects.toBeInstanceOf(LocalCredentialError);
		expect(database.wasAccessed()).toBe(false);
	});

	it("rejects a short enrollment password before database access", async () => {
		const database = unusedPool();
		const store = new LocalCredentialStore(
			database.pool,
			"00000000-0000-4000-8000-000000000001",
		);
		await expect(store.enroll("A".repeat(43), "short")).rejects.toBeInstanceOf(
			LocalCredentialError,
		);
		expect(database.wasAccessed()).toBe(false);
	});
});
