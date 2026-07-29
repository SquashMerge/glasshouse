import { describe, expect, it } from "bun:test";
import { scoreCase } from "../../src/lib/evaluator";
import { ExperimentCreate } from "../../src/schemas/experiments";
import {
	createExperimentHandlers,
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

	it("rejects creation when any dataset item lacks expected output", async () => {
		let created = false;
		const handlers = createExperimentHandlers({
			pool: () => ({}) as never,
			getDataset: async () => ({ id: datasetId }),
			listDatasetItems: async () => ({
				items: [{ id: "case", input: {}, expected_output: null }],
			}),
			createExperiment: async () => {
				created = true;
				return {} as never;
			},
			listExperiments: async () => ({ items: [], total: 0 }),
			getExperiment: async () => ({ status: "completed" }) as never,
			updateExperiment: async () => ({}) as never,
			cancelExperiment: async () => ({}) as never,
			listResults: async () => ({ items: [] }) as never,
			insertResult: async () => ({}) as never,
			summary: async () => ({}) as never,
			invokeLlm: async () => ({ output: {}, model: "test" }),
			trace: async () => {},
		} as never);
		const response = await handlers.handleCreateExperiment({
			req: { valid: () => baseExperiment },
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);

		expect(response.status).toBe(409);
		expect(created).toBe(false);
	});

	it("runs every dataset item, stores results, and emits one trace per item", async () => {
		const statuses: string[] = [];
		const results: unknown[] = [];
		const traces: unknown[] = [];
		const deps = {
			pool: () => ({}) as never,
			getExperiment: async () => ({ status: "running" }),
			getDataset: async () => ({ id: datasetId }),
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

	it("emits a failure trace when an LLM call fails", async () => {
		const results: unknown[] = [];
		const traces: unknown[] = [];
		const deps = {
			pool: () => ({}) as never,
			getExperiment: async () => ({ status: "running" }),
			getDataset: async () => ({ id: datasetId }),
			updateExperiment: async () => ({}) as never,
			listDatasetItems: async () => ({
				items: [
					{
						id: "44444444-4444-4444-8444-444444444444",
						input: { question: "one" },
						expected_output: null,
					},
				],
			}),
			invokeLlm: async () => {
				throw new Error("provider unavailable");
			},
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
		expect(results).toHaveLength(1);
		expect(traces).toHaveLength(1);
		expect((traces[0] as { output: string }).output).toBe("evaluation_failed");
	});

	it("stops before the first item when cancellation is already requested", async () => {
		const controller = new AbortController();
		controller.abort();
		const statuses: string[] = [];
		let invoked = false;
		const deps = {
			pool: () => ({}) as never,
			getExperiment: async () => ({ status: "running" }),
			getDataset: async () => ({
				id: datasetId,
				items: [
					{
						id: "44444444-4444-4444-8444-444444444444",
						input: {},
						expected_output: null,
					},
				],
			}),
			listDatasetItems: async () => ({
				items: [
					{
						id: "44444444-4444-4444-8444-444444444444",
						input: {},
						expected_output: null,
					},
				],
			}),
			updateExperiment: async (_db: unknown, input: { status: string }) => {
				statuses.push(input.status);
				return {} as never;
			},
			invokeLlm: async () => {
				invoked = true;
				return { output: {}, model: "test" };
			},
			insertResult: async () => ({}) as never,
			trace: async () => {},
		} as unknown as ExperimentDependencies;
		await executeExperiment(
			deps,
			{
				project_id: projectId,
				experiment_id: experimentId,
				dataset_id: datasetId,
				config: baseExperiment.config,
			},
			controller.signal,
		);
		expect(invoked).toBe(false);
		expect(statuses).toEqual(["running", "cancelled"]);
	});
});
