import { describe, expect, it } from "bun:test";
import { recoverInterruptedWork } from "../../src/lib/recovery";

describe("startup recovery", () => {
	it("resumes pending and running evaluations after restart", async () => {
		const events: Array<{ event: string; fields: Record<string, unknown> }> =
			[];
		const resumed: string[] = [];
		await recoverInterruptedWork({
			pool: () => ({}) as never,
			recoverExperiments: async () => [
				{
					id: "evaluation",
					project_id: "project",
					dataset_id: "dataset",
					config: { model: "test" },
				},
			],
			failOptimizations: async () => [
				{ id: "optimization", project_id: "project" },
			],
			resumeExperiment: async (experiment) => {
				resumed.push(experiment.id);
			},
			log: (event, fields) => events.push({ event, fields }),
		});

		expect(resumed).toEqual(["evaluation"]);
		expect(events).toEqual([
			{
				event: "work.recovered_after_restart",
				fields: { experiments_resumed: 1, optimizations_failed: 1 },
			},
		]);
	});
});
