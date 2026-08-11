import { describe, expect, it } from "bun:test";
import {
	createExperiment,
	ExperimentRepositoryError,
} from "../../src/db/experiments";

const project_id = "11111111-1111-4111-8111-111111111111";
const dataset_id = "22222222-2222-4222-8222-222222222222";
const agent_id = "33333333-3333-4333-8333-333333333333";
const authorization = {
	organization_id: "44444444-4444-4444-8444-444444444444",
	actor_id: "55555555-5555-4555-8555-555555555555",
	operation: "execute" as const,
};

describe("experiment agent scope", () => {
	it("rejects an agent that is not owned by the experiment project", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		let queries = 0;
		const query = async (text: string, values: unknown[] = []) => {
			calls.push({ text, values });
			queries += 1;
			return { rows: queries === 2 ? [{ id: project_id }] : [] };
		};
		const db = {
			connect: async () => ({ query, release() {} }),
		};

		await expect(
			createExperiment(db, {
				project_id,
				dataset_id,
				agent_id,
				config: {},
				authorization,
			}),
		).rejects.toMatchObject<ExperimentRepositoryError>({
			code: "NOT_FOUND",
			status: 404,
			message: "Agent not found",
		});
		expect(calls[2]?.text).toContain("FROM agents");
		expect(calls[2]?.text).toContain("project_id");
		expect(calls[2]?.values).toContain(agent_id);
	});

	it("locks and rechecks the active project in the insert statement", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const query = async (text: string, values: unknown[] = []) => {
			calls.push({ text, values });
			return { rows: [] };
		};
		const db = {
			connect: async () => ({ query, release() {} }),
		};

		await expect(
			createExperiment(db, {
				project_id,
				dataset_id,
				config: {},
				authorization,
			}),
		).rejects.toMatchObject<ExperimentRepositoryError>({ code: "NOT_FOUND" });
		expect(calls[1]?.text).toContain("FROM projects");
		expect(calls[1]?.text).toContain("authorization_allows_project");
		expect(calls[1]?.text).toContain("FOR UPDATE");
	});
});
