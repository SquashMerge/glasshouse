import { describe, expect, it } from "bun:test";
import { recoverInterruptedWork } from "../../src/lib/recovery";

describe("startup recovery", () => {
	it("fails interrupted evaluations and optimization jobs without blocking boot", async () => {
		const events: Array<{ event: string; fields: Record<string, unknown> }> =
			[];
		await recoverInterruptedWork({
			pool: () => ({}) as never,
			failExperiments: async () => [
				{ id: "evaluation", project_id: "project" },
			],
			failOptimizations: async () => [
				{ id: "optimization", project_id: "project" },
			],
			log: (event, fields) => events.push({ event, fields }),
		});

		expect(events).toEqual([
			{
				event: "work.recovered_after_restart",
				fields: { experiments_failed: 1, optimizations_failed: 1 },
			},
		]);
	});
});
