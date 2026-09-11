import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { admitEvaluationGate } from "../../src/db/evaluation-gates";

const projectId = "11111111-1111-4111-8111-111111111111";
const organizationId = "55555555-5555-4555-8555-555555555555";
const actorId = "66666666-6666-4666-8666-666666666666";
const approvalId = "22222222-2222-4222-8222-222222222222";
const definitionVersionId = "33333333-3333-4333-8333-333333333333";
const datasetVersionId = "44444444-4444-4444-8444-444444444444";
const evaluationId = "77777777-7777-4777-8777-777777777777";
const runId = "88888888-8888-4888-8888-888888888888";

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function requestHash() {
	return createHash("sha256")
		.update(
			canonical({
				operation: "evaluation_run_admission",
				organization_id: organizationId,
				project_id: projectId,
				actor_id: actorId,
				evaluation_selector: evaluationId,
				definition_version: 3,
				expected_dataset_id: null,
				benchmark: null,
				gate: {
					approval_id: approvalId,
					definition_version_id: definitionVersionId,
					dataset_version_id: datasetVersionId,
					gate_context: "ci",
				},
				trigger_metadata: {
					gate_context: "ci",
					gate_approval_id: approvalId,
				},
			}),
		)
		.digest("hex");
}

function pool() {
	const calls: string[] = [];
	const client = {
		query: async (text: string, values: unknown[] = []) => {
			calls.push(text);
			if (text.startsWith("SELECT p.id FROM projects"))
				return { rows: [{ id: projectId }] };
			if (text.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			if (text.includes("approval.revoked_at IS NULL")) return { rows: [] };
			if (text.includes("FROM evaluation_gate_approvals approval"))
				return {
					rows: [
						{
							id: approvalId,
							organization_id: organizationId,
							project_id: projectId,
							evaluation_id: evaluationId,
							definition_version_id: definitionVersionId,
							definition_version: 3,
							dataset_version_id: datasetVersionId,
							definition_content_hash: "definition-hash",
							dataset_content_hash: "dataset-hash",
							gate_context: "ci",
							minimum_pass_rate: 0.9,
							reason: "approved",
							approved_by_actor_id: actorId,
							approved_at: new Date(),
							revoked_at: new Date(),
							revoked_by_actor_id: actorId,
							revocation_reason: "policy changed",
							superseded_by: null,
							created_at: new Date(),
						},
					],
				};
			if (
				text.includes("FROM evaluation_runs run") &&
				values[1] === "retry-key"
			)
				return {
					rows: [
						{
							id: runId,
							organization_id: organizationId,
							project_id: projectId,
							evaluation_id: evaluationId,
							definition_version_id: definitionVersionId,
							dataset_version_id: datasetVersionId,
							dataset_id: "99999999-9999-4999-8999-999999999999",
							experiment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
							benchmark_run_id: null,
							status: "pending",
							requested_by_actor_id: actorId,
							idempotency_key: "retry-key",
							request_hash: requestHash(),
							resolved_inputs_hash: "resolved",
							trigger_metadata: {
								gate_context: "ci",
								gate_approval_id: approvalId,
							},
							created_at: new Date(),
							updated_at: new Date(),
						},
					],
				};
			if (text.startsWith("SELECT input.* FROM evaluation_run_inputs"))
				return {
					rows: [
						{
							target: {
								kind: "configured_llm",
								provider: "openai",
								model: "model",
							},
							target_version: "configured_llm:v1",
							target_fingerprint: "target",
							evaluator: { kind: "exact_match", version: "v1" },
							evaluator_version: "v1",
							evaluator_fingerprint: "evaluator",
							execution_defaults: { temperature: 0, max_tokens: null },
							limits: { max_cost_usd: 1, max_duration_seconds: 1 },
							thresholds: { minimum_pass_rate: 0.9 },
							sampling: { strategy: "first_n", sample_size: 1, seed: 0 },
							sample_identity: "sample",
							ordered_item_snapshot: [],
							resolved_inputs_hash: "resolved",
						},
					],
				};
			if (text.startsWith("SELECT * FROM evaluation_gate_runs"))
				return {
					rows: [
						{
							id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
							organization_id: organizationId,
							project_id: projectId,
							approval_id: approvalId,
							evaluation_run_id: runId,
							evaluation_id: evaluationId,
							definition_version_id: definitionVersionId,
							dataset_version_id: datasetVersionId,
							definition_content_hash: "definition-hash",
							dataset_content_hash: "dataset-hash",
							target_fingerprint: "target",
							evaluator_fingerprint: "evaluator",
							gate_context: "ci",
							minimum_pass_rate: 0.9,
							selected_count: null,
							evaluated_count: null,
							passed_count: null,
							failed_count: null,
							status: "pending",
							outcome_reason: null,
							requested_by_actor_id: actorId,
							idempotency_key: "retry-key",
							created_at: new Date(),
							updated_at: new Date(),
						},
					],
				};
			return { rows: [] };
		},
		release() {},
	};
	return { connect: async () => client, calls };
}

describe("Evaluation Gate idempotent replay", () => {
	it("returns the durable run after approval revocation without new admission work", async () => {
		const db = pool();
		const result = await admitEvaluationGate(db as never, {
			project_id: projectId,
			approval_id: approvalId,
			definition_version_id: definitionVersionId,
			dataset_version_id: datasetVersionId,
			gate_context: "ci",
			idempotency_key: "retry-key",
			authorization: {
				organization_id: organizationId,
				actor_id: actorId,
				operation: "release_gate_manage",
			},
		});

		expect(result.run).toMatchObject({ id: runId, replayed: true });
		expect(result.gate.evaluation_run_id).toBe(runId);
		expect(
			db.calls.some((text) => text.startsWith("INSERT INTO evaluation_runs")),
		).toBe(false);
		expect(
			db.calls.some((text) => text.includes("approval.revoked_at IS NULL")),
		).toBe(false);
	});

	it("rejects a fresh key after approval revocation without inserting work", async () => {
		const db = pool();
		await expect(
			admitEvaluationGate(db as never, {
				project_id: projectId,
				approval_id: approvalId,
				definition_version_id: definitionVersionId,
				dataset_version_id: datasetVersionId,
				gate_context: "ci",
				idempotency_key: "fresh-key",
				authorization: {
					organization_id: organizationId,
					actor_id: actorId,
					operation: "release_gate_manage",
				},
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			db.calls.some((text) => text.includes("approval.revoked_at IS NULL")),
		).toBe(true);
		expect(
			db.calls.some((text) => text.startsWith("INSERT INTO evaluation_runs")),
		).toBe(false);
	});
});
