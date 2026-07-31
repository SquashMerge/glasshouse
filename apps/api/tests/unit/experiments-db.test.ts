import { describe, expect, it } from "bun:test";
import {
	claimExperimentTask,
	cancelExperiment,
	finalizeExperimentTask,
	listRecoverableExperiments,
} from "../../src/db/experiments";

describe("durable experiment task ledger", () => {
	it("does not claim a task from an archived project", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const db = {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return {
					rows: [
						{
							task_id: "33333333-3333-4333-8333-333333333333",
							dataset_item_id: "44444444-4444-4444-8444-444444444444",
							lease_token: "55555555-5555-4555-8555-555555555555",
							input: { question: "one" },
							expected_output: { value: "answer" },
						},
					],
				};
			},
		};

		const task = await claimExperimentTask(db, {
			project_id: "11111111-1111-4111-8111-111111111111",
			experiment_id: "22222222-2222-4222-8222-222222222222",
			lease_seconds: 30,
		});

		expect(task).toMatchObject({
			id: "33333333-3333-4333-8333-333333333333",
			dataset_item_id: "44444444-4444-4444-8444-444444444444",
			lease_token: expect.any(String),
		});
		expect(calls[0]?.text).toContain("SKIP LOCKED");
		expect(calls[0]?.text).toContain("lease_expires_at <= now()");
		expect(calls[0]?.text).toContain("t.status = 'pending'");
		expect(calls[0]?.text).toContain("e.status = 'running'");
		expect(calls[0]?.text).toContain("p.status = 'active'");
	});

	it("does not finalize a task after its project is archived during work", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const db = {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [{ finalized: true }] };
			},
		};

		const finalized = await finalizeExperimentTask(db, {
			project_id: "11111111-1111-4111-8111-111111111111",
			experiment_id: "22222222-2222-4222-8222-222222222222",
			task_id: "33333333-3333-4333-8333-333333333333",
			lease_token: "44444444-4444-4444-8444-444444444444",
			status: "completed",
			output: { value: "answer" },
			scores: { exact_match: 1 },
			duration_ms: 12,
			agent_version: "test-model",
		});

		expect(finalized).toBe(true);
		expect(calls[0]?.text).toContain("t.lease_token = $4::uuid");
		expect(calls[0]?.text).toContain("e.status = 'running'");
		expect(calls[0]?.text).toContain("p.status = 'active'");
		expect(calls[0]?.text).toContain(
			"ON CONFLICT (experiment_id, dataset_item_id) DO NOTHING",
		);
	});

	it("returns pending and running experiments for restart recovery rather than failing them", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const db = {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return {
					rows: [
						{
							id: "33333333-3333-4333-8333-333333333333",
							project_id: "11111111-1111-4111-8111-111111111111",
							dataset_id: "22222222-2222-4222-8222-222222222222",
							config: { model: "test-model" },
						},
					],
				};
			},
		};

		expect(await listRecoverableExperiments(db)).toHaveLength(1);
		expect(calls[0]?.text).toContain("status IN ('pending', 'running')");
		expect(calls[0]?.text).toContain("p.status = 'active'");
		expect(calls[0]?.text).toContain("ORDER BY e.created_at ASC");
	});

	it("terminalizes experiment tasks when a project is archived so restore cannot recover them", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const db = {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return { rows: [] };
			},
		};

		await listRecoverableExperiments(db);

		expect(calls[0]?.text).toContain("e.status IN ('pending', 'running')");
		expect(calls[0]?.text).toContain("p.status = 'active'");
	});

	it("does not cancel an experiment after its project is archived", async () => {
		const calls: string[] = [];
		const db = {
			query: async (text: string) => {
				calls.push(text);
				return { rows: [] };
			},
		};

		await expect(
			cancelExperiment(db, {
				project_id: "11111111-1111-4111-8111-111111111111",
				id: "22222222-2222-4222-8222-222222222222",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(calls[0]).toContain("status='active' FOR UPDATE");
	});
});
