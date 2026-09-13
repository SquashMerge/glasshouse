import { describe, expect, it } from "bun:test";
import {
	cancelExperiment,
	claimExperimentTask,
	experimentSummary,
	finalizeExperimentTask,
	getExperiment,
	listExperimentResults,
	listRecoverableExperiments,
	reconcileUnknownExperimentTaskProviderDispatch,
} from "../../src/db/experiments";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "99999999-9999-4999-8999-999999999999";
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
	let executionAuthorized = true;
	const client = {
		query: async (text: string, values: unknown[] = []) => {
			if (text.startsWith("SELECT p.id AS authorization_project_id")) {
				calls.push({ text, values });
				return {
					rows: [
						{
							authorization_project_id: projectId,
							organization_id: authorization.organization_id,
							requested_by_actor_id: authorization.actor_id,
						},
					],
				};
			}
			if (text.includes("p.status = ANY($3::text[])")) {
				calls.push({ text, values });
				return { rows: [{ id: projectId }] };
			}
			if (text.includes("FROM organization_memberships om"))
				return { rows: [{ actor_subject: "requester" }] };
			if (text.includes("FROM organization_actor_roles"))
				return { rows: [{ actor_id: authorization.actor_id }] };
			if (text.includes("FROM project_memberships pm"))
				return { rows: [{ actor_subject: "requester" }] };
			if (text.includes("FROM project_actor_grants"))
				return { rows: [{ actor_id: authorization.actor_id }] };
			if (text.startsWith("SELECT authorization_allows_project"))
				return {
					rows: [
						{
							allowed:
								executionAuthorized &&
								responses[0]?.rows?.[0]?.authorized !== false,
						},
					],
				};
			if (text.startsWith("SELECT e.* FROM experiments")) {
				calls.push({ text, values });
				const reply = responses.shift() ?? { rows: [] };
				executionAuthorized = reply.rows?.[0]?.authorized !== false;
				return reply;
			}
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
	it("does not read an experiment from another authorized project", async () => {
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
			getExperiment({ connect: async () => client } as never, {
				id: experimentId,
				project_id: otherProjectId,
				authorization: { ...authorization, operation: "product_read" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			calls.find((call) => call.text.startsWith("SELECT e.* FROM experiments")),
		).toMatchObject({ values: [experimentId, otherProjectId] });
	});

	it("does not expose another authorized project's experiment results or summary", async () => {
		for (const read of [listExperimentResults, experimentSummary]) {
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
				read({ connect: async () => client } as never, {
					id: experimentId,
					project_id: otherProjectId,
					authorization: { ...authorization, operation: "product_read" },
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(
				calls.find((call) =>
					call.text.startsWith("SELECT e.* FROM experiments"),
				),
			).toMatchObject({ values: [experimentId, otherProjectId] });
			expect(
				calls.some((call) => call.text.includes("FROM experiment_results")),
			).toBe(false);
		}
	});

	it("overwrites stale result evidence when reconciling unknown dispatch", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const client = {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				if (text.startsWith("SELECT p.id AS authorization_project_id"))
					return {
						rows: [
							{
								authorization_project_id: projectId,
								organization_id: authorization.organization_id,
								requested_by_actor_id: authorization.actor_id,
							},
						],
					};
				if (text.includes("FROM organization_memberships om"))
					return { rows: [{ actor_subject: "requester" }] };
				if (text.includes("FROM organization_actor_roles"))
					return { rows: [{ actor_id: authorization.actor_id }] };
				if (text.includes("FROM project_memberships pm"))
					return { rows: [{ actor_subject: "requester" }] };
				if (text.includes("FROM project_actor_grants"))
					return { rows: [{ actor_id: authorization.actor_id }] };
				if (text.includes("p.status = ANY($3::text[])"))
					return { rows: [{ id: projectId }] };
				if (text.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (text.startsWith("SELECT e.* FROM experiments"))
					return { rows: [runningExperiment] };
				if (text.startsWith("UPDATE experiment_tasks"))
					return {
						rows: [
							{
								experiment_id: experimentId,
								dataset_item_id: datasetId,
								dataset_version_item_id: null,
								evaluation_run_item_id: null,
								evaluation_run_id: null,
							},
						],
					};
				return { rows: [] };
			},
			release() {},
		};

		expect(
			await reconcileUnknownExperimentTaskProviderDispatch(
				{ connect: async () => client } as never,
				{
					project_id: projectId,
					experiment_id: experimentId,
					task_id: taskId,
					lease_token: leaseToken,
				},
			),
		).toBe(true);
		const resultInsert = calls.find((call) =>
			call.text.startsWith("INSERT INTO experiment_results"),
		);
		expect(resultInsert?.text).toContain("DO UPDATE SET");
		expect(resultInsert?.text).toContain(
			"error_classification=excluded.error_classification",
		);
	});

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
		expect(db.calls.some((call) => call.text.includes("SKIP LOCKED"))).toBe(
			true,
		);
	});

	it("claims immutable published snapshot items without falling back to drafts", async () => {
		const snapshotItemId = "88888888-8888-4888-8888-888888888888";
		const db = transactionPool([
			{ rows: [] },
			{ rows: [runningExperiment] },
			{ rows: [{ id: taskId, dataset_version_item_id: snapshotItemId }] },
			{
				rows: [
					{
						id: taskId,
						dataset_version_item_id: snapshotItemId,
						lease_token: leaseToken,
					},
				],
			},
			{
				rows: [
					{
						input: { question: "published" },
						expected_output: { value: "one" },
					},
				],
			},
			{ rows: [] },
		]);

		await expect(
			claimExperimentTask(db as never, {
				project_id: projectId,
				experiment_id: experimentId,
			}),
		).resolves.toMatchObject({ dataset_item_id: snapshotItemId });
		const itemQuery = db.calls.find(
			(call) =>
				call.text.includes("FROM experiment_tasks") &&
				call.text.includes("evaluation_run_items"),
		);
		expect(itemQuery?.text).toContain(
			"item.dataset_version_id = experiment.resolved_dataset_version_id",
		);
		expect(itemQuery?.values).toEqual([taskId, null, projectId]);
	});

	it("fails closed when a legacy task item is outside the experiment project", async () => {
		const legacyItemId = "88888888-8888-4888-8888-888888888889";
		const db = transactionPool([
			{ rows: [] },
			{ rows: [runningExperiment] },
			{ rows: [{ id: taskId, dataset_item_id: legacyItemId }] },
			{
				rows: [
					{
						id: taskId,
						dataset_item_id: legacyItemId,
						lease_token: leaseToken,
					},
				],
			},
			{ rows: [] },
		]);

		await expect(
			claimExperimentTask(db as never, {
				project_id: projectId,
				experiment_id: experimentId,
			}),
		).rejects.toMatchObject({
			code: "INTERNAL",
			message: "Dataset item not found",
		});
		const itemQuery = db.calls.find((call) =>
			call.text.includes("FROM dataset_items"),
		);
		expect(itemQuery?.text).toContain("id = $2 AND project_id = $3");
		expect(itemQuery?.values).toEqual([taskId, legacyItemId, projectId]);
	});

	it("does not finalize a result after requester execution access is revoked", async () => {
		const db = transactionPool([
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
		expect(db.calls.map((call) => call.text)).not.toContain(
			expect.stringContaining("INSERT INTO experiment_results"),
		);
	});

	it("binds the lease and result state to the finalized task", async () => {
		const db = transactionPool([
			{ rows: [runningExperiment] },
			{ rows: [runningExperiment] },
			{ rows: [] },
			{
				rows: [
					{
						experiment_id: experimentId,
						dataset_item_id: datasetId,
						final_status: "completed",
					},
				],
			},
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
		expect(
			db.calls.find((call) => call.text.startsWith("UPDATE experiment_tasks"))
				?.values,
		).toEqual([taskId, experimentId, leaseToken, "completed", null, null]);
	});

	it("terminalizes without result content when the result admission has expired", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const client = {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				if (text.startsWith("SELECT p.id AS authorization_project_id"))
					return {
						rows: [
							{
								authorization_project_id: projectId,
								organization_id: authorization.organization_id,
								requested_by_actor_id: authorization.actor_id,
							},
						],
					};
				if (text.includes("FROM organization_memberships om"))
					return { rows: [{ actor_subject: "requester" }] };
				if (text.includes("FROM organization_actor_roles"))
					return { rows: [{ actor_id: authorization.actor_id }] };
				if (text.includes("FROM project_memberships pm"))
					return { rows: [{ actor_subject: "requester" }] };
				if (text.includes("FROM project_actor_grants"))
					return { rows: [{ actor_id: authorization.actor_id }] };
				if (text.includes("FROM projects p WHERE"))
					return { rows: [{ id: projectId }] };
				if (text.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (text.startsWith("SELECT e.* FROM experiments"))
					return { rows: [runningExperiment] };
				if (text.startsWith("WITH active_admission")) return { rows: [] };
				if (text.startsWith("UPDATE experiment_tasks"))
					return { rows: [{ id: taskId }] };
				return { rows: [{ max_cost_usd: null, spent_cost_usd: 0 }] };
			},
			release() {},
		};

		expect(
			await finalizeExperimentTask({ connect: async () => client } as never, {
				project_id: projectId,
				experiment_id: experimentId,
				task_id: taskId,
				lease_token: leaseToken,
				admission_id: "88888888-8888-4888-8888-888888888888",
				status: "completed",
				output: { value: "must not persist" },
				scores: { exact_match: 1 },
			}),
		).toBe(true);
		const terminalize = calls.find(
			(call) =>
				call.text.startsWith("UPDATE experiment_tasks") &&
				call.text.includes("last_error_classification='execution_timeout'"),
		);
		expect(terminalize).toBeDefined();
		expect(
			calls.some((call) =>
				call.text.startsWith("INSERT INTO experiment_results"),
			),
		).toBe(false);
	});

	it("does not claim a terminal result effect when a task is returned for retry", async () => {
		const db = transactionPool([
			{ rows: [runningExperiment] },
			{ rows: [runningExperiment] },
			{ rows: [] },
			{
				rows: [
					{
						experiment_id: experimentId,
						dataset_item_id: datasetId,
						final_status: "pending",
					},
				],
			},
		]);

		const result = await finalizeExperimentTask(db as never, {
			project_id: projectId,
			experiment_id: experimentId,
			task_id: taskId,
			lease_token: leaseToken,
			status: "failed",
			retryable: true,
			scores: { exact_match: 0 },
			error_classification: "provider_error",
			error_message: "provider invocation failed",
		});
		expect(result).toBe(true);
		expect(
			db.calls.some((call) => call.text.includes("execution_effects")),
		).toBe(false);
	});

	it("terminalizes unbound or revoked work before restart recovery", async () => {
		const db = transactionPool([
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{
				rows: [
					{
						id: experimentId,
						project_id: projectId,
					},
				],
			},
			{ rows: [runningExperiment] },
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
		expect(
			db.calls.find((call) =>
				call.text.includes("FROM experiments experiment LEFT JOIN"),
			)?.text,
		).toContain("status IN ('pending', 'running')");
		expect(db.calls.some((call) => call.text.includes("FOR UPDATE OF p"))).toBe(
			true,
		);
	});

	it("fails closed instead of restoring mutable config for an admitted run without its snapshot", async () => {
		const db = transactionPool([
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{
				rows: [
					{
						...runningExperiment,
						evaluation_run_id: "88888888-8888-4888-8888-888888888888",
						config: { model: "mutable-draft" },
					},
				],
			},
			{ rows: [] },
		]);

		expect(await listRecoverableExperiments(db as never)).toEqual([]);
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
		expect(
			db.calls.some((call) =>
				call.text.startsWith("UPDATE experiments SET status='cancelled'"),
			),
		).toBe(true);
	});
});
