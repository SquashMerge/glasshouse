import { describe, expect, it } from "bun:test";
import { scoreCase } from "../../src/lib/evaluator";
import { ExperimentCreate } from "../../src/schemas/experiments";
import {
	executeExperiment,
	type ExperimentDependencies,
} from "../../src/routes/experiments";

const projectId = "11111111-1111-4111-8111-111111111111";
const datasetId = "22222222-2222-4222-8222-222222222222";
const experimentId = "33333333-3333-4333-8333-333333333333";

const baseExperiment = {
	project_id: projectId,
	dataset_id: datasetId,
	name: "smoke",
	config: {
		model: "test-model",
		evaluator: "contains" as const,
		temperature: 0,
	},
};

describe("evaluation MVP", () => {
	it("defaults to the exact-match evaluator and temperature", () => {
		const parsed = ExperimentCreate.parse({
			project_id: projectId,
			dataset_id: datasetId,
		});
		expect(parsed.config).toEqual({ evaluator: "exact_match", temperature: 0 });
	});

	it("scores exact matches and case-insensitive containment", () => {
		expect(
			scoreCase("exact_match", { value: "yes" }, { value: "yes" }),
		).toEqual({ exact_match: 1 });
		expect(scoreCase("contains", "YES", { value: "yes, definitely" })).toEqual({
			contains: 1,
		});
	});

	it("runs every dataset item, stores results, and emits one trace per item", async () => {
		const statuses: string[] = [];
		const results: unknown[] = [];
		const traces: unknown[] = [];
		const deps = {
			pool: () => ({}) as never,
			updateExperiment: async (_db: unknown, input: { status: string }) => {
				statuses.push(input.status);
				return {} as never;
			},
			listDatasetItems: async () => ({
				items: [
					{
						id: "44444444-4444-4444-8444-444444444444",
						input: { question: "one" },
						expected_output: { value: "answer" },
					},
					{
						id: "55555555-5555-4555-8555-555555555555",
						input: { question: "two" },
						expected_output: { value: "answer" },
					},
				],
			}),
			invokeLlm: async () => ({
				output: { value: "answer" },
				model: "test-model",
			}),
			insertResult: async (_db: unknown, input: unknown) => {
				results.push(input);
				return {} as never;
			},
			trace: async (input: unknown) => {
				traces.push(input);
			},
		} as unknown as ExperimentDependencies;

		await executeExperiment(deps, {
			project_id: projectId,
			experiment_id: experimentId,
			dataset_id: datasetId,
			config: baseExperiment.config,
		});
		expect(statuses).toEqual(["running", "completed"]);
		expect(results).toHaveLength(2);
		expect(traces).toHaveLength(2);
		expect((results[0] as { scores: Record<string, number> }).scores).toEqual({
			contains: 1,
		});
	});
});
