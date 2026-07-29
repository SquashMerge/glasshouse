import { describe, expect, it } from "bun:test";
import { executeBenchmarkExperiment } from "../../src/routes/benchmarks";
import type { ExperimentDependencies } from "../../src/routes/experiments";

const projectId = "11111111-1111-4111-8111-111111111111";
const experimentId = "22222222-2222-4222-8222-222222222222";
const datasetId = "33333333-3333-4333-8333-333333333333";

describe("benchmark evaluation execution", () => {
	it("marks the experiment failed when background execution rejects", async () => {
		const transitions: Array<{
			status: string;
			if_status?: string | string[];
		}> = [];
		const dependencies = {
			pool: () => ({}) as never,
			updateExperiment: async (
				_db: unknown,
				input: { status: string; if_status?: string | string[] },
			) => {
				transitions.push(input);
				return {} as never;
			},
		} as ExperimentDependencies;

		await executeBenchmarkExperiment(
			{
				project_id: projectId,
				experiment_id: experimentId,
				dataset_id: datasetId,
				config: {},
			},
			dependencies,
			async () => {
				throw new Error("provider unavailable");
			},
		);

		expect(transitions).toContainEqual(
			expect.objectContaining({
				status: "failed",
				if_status: ["pending", "running"],
			}),
		);
	});
});
