import { describe, expect, it } from "bun:test";
import {
	cancelExperiment,
	claimExperimentTask,
	finalizeExperimentTask,
	listRecoverableExperiments,
} from "../../src/db/experiments";

const projectId = "11111111-1111-4111-8111-111111111111";
const experimentId = "22222222-2222-4222-8222-222222222222";
const datasetId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const leaseToken = "55555555-5555-4555-8555-555555555555";
const authorization = {
	organization_id: "66666666-6666-4666-8666-666666666666",
	actor_id: "77777777-7777-4777-8777-777777777777",
	operation: "execute" as const,
};

function transactionPool(
	responses: Array<{ rows?: Record<string, unknown>[]; rowCount?: number }>,
) {
	const calls: Array<{ text: string; values: unknown[] }> = [];
	const client = {
		query: async (text: string, values: unknown[] = []) => {
			calls.push({ text, values });
			return responses.shift() ?? { rows: [] };
		},
		release() {},
	};
	return { calls, connect: async () => client };
}

const runningExperiment = {
	id: experimentId,
	project_id: projectId,
	dataset_id: datasetId,
	status: "running",
	config: {},
	requested_by_actor_id: authorization.actor_id,
	authorized: true,
};

describe("durable experiment task ledger", () => {
	it("rechecks the requester under the project lock before claiming provider work", async () => {
		const db = transactionPool([
			{ rows: [] },
			{ rows: [runningExperiment] },
			{ rows: [{ id: taskId, dataset_item_id: datasetId }] },
			{
				rows: [
					{ id: taskId, dataset_item_id: datasetId, lease_token: leaseToken },
				],
			},
			{
				rows: [
					{ input: { question: "one" }, expected_output: { value: "one" } },
				],
			},
			{ rows: [] },
		]);

		const task = await claimExperimentTask(db as never, {
			project_id: projectId,
			experiment_id: experimentId,
			lease_seconds: 30,
		});

		expect(task).toMatchObject({
			id: taskId,
			dataset_item_id: datasetId,
			lease_token: leaseToken,
		});
		expect(db.calls[1]?.text).toContain("requested_by_actor_id IS NOT NULL");
		expect(db.calls[1]?.text).toContain("authorization_allows_project");
		expect(db.calls[1]?.text).toContain("FOR UPDATE OF e, p");
		expect(db.calls[2]?.text).toContain("SKIP LOCKED");
	});

	it("does not finalize a result after requester execution access is revoked", async () => {
		const db = transactionPool([
			{ rows: [] },
			{ rows: [{ ...runningExperiment, authorized: false }] },
			{ rows: [] },
			{ rows: [{ ...runningExperiment, status: "cancelled" }] },
			{ rows: [] },
		]);

		const finalized = await finalizeExperimentTask(db as never, {
			project_id: projectId,
			experiment_id: experimentId,
			task_id: taskId,
			lease_token: leaseToken,
			status: "completed",
			output: { value: "answer" },
			scores: { exact_match: 1 },
			duration_ms: 12,
			agent_version: "test-model",
		});

		expect(finalized).toBe(false);
		expect(db.calls[1]?.text).toContain("authorization_allows_project");
		expect(db.calls.map((call) => call.text)).not.toContain(
			expect.stringContaining("INSERT INTO experiment_results"),
		);
		expect(db.calls[2]?.text).toContain("UPDATE experiment_tasks");
	});

	it("binds the lease and result state to the finalized task", async () => {
		const db = transactionPool([
			{ rows: [] },
			{ rows: [runningExperiment] },
			{ rows: [{ experiment_id: experimentId, dataset_item_id: datasetId }] },
			{ rows: [] },
			{ rows: [] },
		]);

		expect(
			await finalizeExperimentTask(db as never, {
				project_id: projectId,
				experiment_id: experimentId,
				task_id: taskId,
				lease_token: leaseToken,
				status: "completed",
				scores: { exact_match: 1 },
			}),
		).toBe(true);
		expect(db.calls[2]?.values).toEqual([
			taskId,
			experimentId,
			leaseToken,
			"completed",
		]);
	});

	it("terminalizes unbound or revoked work before restart recovery", async () => {
		const db = transactionPool([
			{ rows: [] },
			{ rows: [{ id: experimentId }] },
			{ rows: [] },
			{ rows: [] },
			{
				rows: [
					{
						id: experimentId,
						project_id: projectId,
						dataset_id: datasetId,
						config: {},
					},
				],
			},
			{ rows: [] },
		]);

		expect(await listRecoverableExperiments(db as never)).toEqual([
			{
				id: experimentId,
				project_id: projectId,
				dataset_id: datasetId,
				config: {},
			},
		]);
		expect(db.calls[1]?.text).toContain("requested_by_actor_id IS NULL");
		expect(db.calls[1]?.text).toContain("authorization_allows_project");
		expect(db.calls[4]?.text).toContain("requested_by_actor_id IS NOT NULL");
		expect(db.calls[4]?.text).toContain("FOR UPDATE OF e, p");
	});

	it("rechecks the cancelling actor under the project lock", async () => {
		const db = transactionPool([{ rows: [] }, { rows: [] }, { rows: [] }]);
		await expect(
			cancelExperiment(db as never, {
				project_id: projectId,
				id: experimentId,
				authorization,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(db.calls[1]?.text).toContain("authorization_allows_project");
		expect(db.calls[1]?.text).toContain("FOR UPDATE OF p");
	});
});
