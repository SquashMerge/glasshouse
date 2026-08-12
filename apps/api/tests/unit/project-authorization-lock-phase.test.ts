import { expect, test } from "bun:test";
import { withLockPhaseTransaction } from "../../src/db/project-authorization";

test("retries a deadlocked lock phase without replaying the mutation", async () => {
	let attempts = 0;
	let mutations = 0;
	const client = {
		query: async () => ({ rows: [] }),
		release() {},
	};
	const pool = {
		connect: async () => client,
	};

	await withLockPhaseTransaction(
		pool as never,
		async () => {
			attempts += 1;
			if (attempts === 1)
				throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
		},
		async () => {
			mutations += 1;
		},
	);

	expect(attempts).toBe(2);
	expect(mutations).toBe(1);
});

test("does not retry after a mutation has started", async () => {
	let attempts = 0;
	let mutations = 0;
	const failure = Object.assign(new Error("serialization failure"), {
		code: "40001",
	});
	const client = {
		query: async () => ({ rows: [] }),
		release() {},
	};
	const pool = {
		connect: async () => client,
	};

	await expect(
		withLockPhaseTransaction(
			pool as never,
			async () => {
				attempts += 1;
			},
			async () => {
				mutations += 1;
				throw failure;
			},
		),
	).rejects.toBe(failure);

	expect(attempts).toBe(1);
	expect(mutations).toBe(1);
});
