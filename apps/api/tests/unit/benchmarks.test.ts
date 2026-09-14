import { describe, expect, it } from "bun:test";
import {
	benchmarkRunProjectId,
	executeBenchmarkExperiment,
} from "../../src/routes/benchmarks";
import type { ExperimentDependencies } from "../../src/routes/experiments";
import {
	createBenchmarkRun,
	createBenchmarkSuite,
	listBenchmarkRuns,
} from "../../src/db/benchmarks";
import { BenchmarkRunCreate } from "../../src/schemas/benchmarks";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "99999999-9999-4999-8999-999999999999";
const experimentId = "22222222-2222-4222-8222-222222222222";
const datasetId = "33333333-3333-4333-8333-333333333333";

describe("benchmark evaluation execution", () => {
	it("does not read a suite or its runs from another authorized project", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const client = {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				if (text.includes("FROM projects p"))
					return { rows: [{ id: otherProjectId }] };
				if (text.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				return { rows: [] };
			},
			release() {},
		};
		await expect(
			listBenchmarkRuns({ connect: async () => client } as never, {
				suite_id: datasetId,
				project_id: otherProjectId,
				authorization: {
					organization_id: "66666666-6666-4666-8666-666666666666",
					actor_id: "77777777-7777-4777-8777-777777777777",
					operation: "product_read",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			calls.find((call) =>
				call.text.startsWith("SELECT b.* FROM benchmark_suites"),
			),
		).toMatchObject({ values: [datasetId, otherProjectId] });
		expect(
			calls.some((call) =>
				call.text.startsWith("SELECT br.* FROM benchmark_runs"),
			),
		).toBe(false);
	});

	it("locks and authorizes the active project before benchmark writes", () => {
		for (const operation of [createBenchmarkSuite, createBenchmarkRun])
			expect(operation.toString()).toContain("lockActiveAuthorizedProject");
	});

	it("requires an active published dataset before creating a benchmark suite", () => {
		expect(createBenchmarkSuite.toString()).toContain(
			"dataset.archived_at IS NULL",
		);
		expect(createBenchmarkSuite.toString()).toContain(
			"dataset.latest_published_version IS NOT NULL",
		);
	});

	it("requires admission inputs and rejects mutable benchmark configuration", () => {
		expect(() =>
			BenchmarkRunCreate.parse({
				project_id: projectId,
				evaluation_id: "44444444-4444-4444-8444-444444444444",
				definition_version: 1,
				idempotency_key: "benchmark-once",
				label: "baseline",
			}),
		).toThrow();
		expect(() =>
			BenchmarkRunCreate.parse({
				project_id: projectId,
				label: "baseline",
			}),
		).toThrow();
		expect(() =>
			BenchmarkRunCreate.parse({
				project_id: projectId,
				evaluation_id: "44444444-4444-4444-8444-444444444444",
				definition_version: 1,
				idempotency_key: "benchmark-once",
				label: "baseline",
				config: { model: "mutable-override" },
			}),
		).toThrow();
		expect(() =>
			BenchmarkRunCreate.parse({
				project_id: projectId,
				evaluation_id: "44444444-4444-4444-8444-444444444444",
				definition_version: 1,
				idempotency_key: "benchmark-once",
				label: "baseline",
				model: "unapproved-model",
			}),
		).toThrow();
	});

	it("rejects a benchmark run body selector that conflicts with its query selector", () => {
		expect(() => benchmarkRunProjectId(projectId, otherProjectId)).toThrow(
			"must match the query selector",
		);
	});

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
