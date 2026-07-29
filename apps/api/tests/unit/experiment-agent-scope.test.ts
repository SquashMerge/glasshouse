import { describe, expect, it } from "bun:test";
import {
	createExperiment,
	ExperimentRepositoryError,
} from "../../src/db/experiments";

const project_id = "11111111-1111-4111-8111-111111111111";
const dataset_id = "22222222-2222-4222-8222-222222222222";
const agent_id = "33333333-3333-4333-8333-333333333333";

describe("experiment agent scope", () => {
	it("rejects an agent that is not owned by the experiment project", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const db = {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [] };
			},
		};

		await expect(
			createExperiment(db, {
				project_id,
				dataset_id,
				agent_id,
				config: {},
			}),
		).rejects.toMatchObject<ExperimentRepositoryError>({
			code: "NOT_FOUND",
			status: 404,
			message: "Agent not found",
		});
		expect(calls[0]?.text).toContain("FROM agents");
		expect(calls[0]?.text).toContain("project_id");
		expect(calls[0]?.values).toContain(agent_id);
	});
});
