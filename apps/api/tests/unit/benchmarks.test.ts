import { describe, expect, it } from "bun:test";
import { executeBenchmarkExperiment } from "../../src/routes/benchmarks";
import type { ExperimentDependencies } from "../../src/routes/experiments";
import {
	createBenchmarkRun,
	createBenchmarkSuite,
	getBenchmarkSuite,
} from "../../src/db/benchmarks";

const projectId = "11111111-1111-4111-8111-111111111111";
const experimentId = "22222222-2222-4222-8222-222222222222";
const datasetId = "33333333-3333-4333-8333-333333333333";

describe("benchmark evaluation execution", () => {
	it("rejects a suite read after product access is revoked", async () => {
		const calls: string[] = [];
		const client = {
			query: async (text: string) => {
				calls.push(text);
				if (text.startsWith("SELECT project_id FROM benchmark_suites"))
					return { rows: [{ project_id: projectId }] };
				if (text.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: false }] };
				return { rows: [] };
			},
			release() {},
		};
		await expect(
			getBenchmarkSuite({ connect: async () => client } as never, {
				id: datasetId,
				project_id: "88888888-8888-4888-8888-888888888888",
				authorization: {
					organization_id: "66666666-6666-4666-8666-666666666666",
					actor_id: "77777777-7777-4777-8777-777777777777",
					operation: "product_read",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			calls.some((text) => text.startsWith("SELECT b.* FROM benchmark_suites")),
		).toBe(false);
	});

	it("locks and authorizes the active project before benchmark writes", () => {
		for (const operation of [createBenchmarkSuite, createBenchmarkRun])
			expect(operation.toString()).toContain("lockActiveAuthorizedProject");
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
