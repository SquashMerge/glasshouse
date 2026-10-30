import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
	admitEvaluationGate,
	listEvaluationGateApprovals,
} from "../../src/db/evaluation-gates";

const projectId = "11111111-1111-4111-8111-111111111111";
const organizationId = "55555555-5555-4555-8555-555555555555";
const actorId = "66666666-6666-4666-8666-666666666666";
const approvalId = "22222222-2222-4222-8222-222222222222";
const definitionVersionId = "33333333-3333-4333-8333-333333333333";
const datasetVersionId = "44444444-4444-4444-8444-444444444444";
const evaluationId = "77777777-7777-4777-8777-777777777777";
const runId = "88888888-8888-4888-8888-888888888888";
const definitionContentHash = "a".repeat(64);
const datasetContentHash = "b".repeat(64);

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

function pool({ expectedOutputPath = "$.constructor", revoked = true } = {}) {
	const calls: string[] = [];
	const definition = {
		id: definitionVersionId,
		organization_id: organizationId,
		project_id: projectId,
		evaluation_id: evaluationId,
		evaluation_name: "Historical gate",
		version: 3,
		dataset_version_id: datasetVersionId,
		dataset_id: "99999999-9999-4999-8999-999999999999",
		content_hash: definitionContentHash,
		dataset_content_hash: datasetContentHash,
		sampling: { strategy: "first_n", sample_size: 1, seed: 0 },
		evaluator: {
			kind: "exact_match",
			version: "v1",
			expected_output_path: expectedOutputPath,
			output_path: "$.output",
		},
		target: {
			kind: "configured_llm",
			provider: "openai",
			model: "gpt-4o-mini",
			system_prompt: null,
		},
		execution_defaults: { temperature: 0, max_tokens: null },
		limits: { max_cost_usd: 1, max_duration_seconds: 60 },
		thresholds: { minimum_pass_rate: 0.9 },
	};
	const approval = {
		id: approvalId,
		organization_id: organizationId,
		project_id: projectId,
		evaluation_id: definition.evaluation_id,
		definition_version_id: definition.id,
		definition_version: definition.version,
		definition_evaluator: definition.evaluator,
		dataset_version_id: definition.dataset_version_id,
		definition_content_hash: definition.content_hash,
		dataset_content_hash: definition.dataset_content_hash,
		gate_context: "ci",
		minimum_pass_rate: definition.thresholds.minimum_pass_rate,
		reason: "approved",
		approved_by_actor_id: actorId,
		approved_at: new Date(),
		revoked_at: revoked ? new Date() : null,
		revoked_by_actor_id: revoked ? actorId : null,
		revocation_reason: revoked ? "policy changed" : null,
		superseded_by: null,
		created_at: new Date(),
	};
	const client = {
		query: async (text: string, values: unknown[] = []) => {
			calls.push(text);
			if (text.startsWith("SELECT p.id FROM projects"))
				return { rows: [{ id: projectId }] };
			if (text.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			if (
				text.includes("FROM evaluation_gate_approvals approval") &&
				text.includes("definition.evaluator AS definition_evaluator")
			) {
				const matches = text.includes("WHERE approval.id = $1")
					? values[0] === approval.id && values[1] === approval.project_id
					: values[0] === approval.project_id &&
						(values[1] === true || approval.revoked_at === null);
				return { rows: matches ? [approval] : [] };
			}
			if (
				text.includes("FROM evaluation_gate_approvals approval") &&
				text.includes("approval.revoked_at IS NULL")
			)
				return {
					rows:
						approval.revoked_at === null &&
						values[0] === approval.id &&
						values[1] === approval.organization_id &&
						values[2] === approval.project_id &&
						values[3] === approval.gate_context &&
						approval.definition_content_hash === definition.content_hash &&
						approval.dataset_content_hash === definition.dataset_content_hash
							? [
									{
										id: approval.id,
										definition_version_id: approval.definition_version_id,
										dataset_version_id: approval.dataset_version_id,
										gate_context: approval.gate_context,
										minimum_pass_rate: approval.minimum_pass_rate,
										evaluation_id: definition.evaluation_id,
										version: definition.version,
										content_hash: definition.content_hash,
										dataset_content_hash: definition.dataset_content_hash,
									},
								]
							: [],
				};
			if (text.includes("FROM evaluation_definition_versions definition"))
				return {
					rows:
						values[0] === definition.project_id &&
						values[1] === definition.evaluation_id &&
						values[2] === definition.version &&
						values[5] === definition.id &&
						values[6] === definition.dataset_version_id
							? [definition]
							: [],
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
							definition_content_hash: definitionContentHash,
							dataset_content_hash: datasetContentHash,
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

describe("Evaluation Gate approval executability", () => {
	it("reports an active historical approval as incompatible when its path is no longer safe", async () => {
		const db = pool({ revoked: false });
		const result = await listEvaluationGateApprovals(db as never, {
			project_id: projectId,
			include_revoked: true,
			authorization: {
				organization_id: organizationId,
				actor_id: actorId,
				operation: "product_read",
			},
		});

		expect(result.items[0]).toMatchObject({
			definition_version_id: definitionVersionId,
			definition_contract: "legacy_incompatible",
			status: "active",
			revoked_at: null,
		});
		expect(
			db.calls.some((text) =>
				text.includes("definition.evaluator AS definition_evaluator"),
			),
		).toBe(true);
	});

	it("rejects a fresh key for an active legacy-incompatible approval before persisting work", async () => {
		const db = pool({ revoked: false, expectedOutputPath: "$.constructor" });
		const result = await listEvaluationGateApprovals(db as never, {
			project_id: projectId,
			authorization: {
				organization_id: organizationId,
				actor_id: actorId,
				operation: "product_read",
			},
		});
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			id: approvalId,
			definition_version_id: definitionVersionId,
			definition_version: 3,
			dataset_version_id: datasetVersionId,
			definition_content_hash: definitionContentHash,
			dataset_content_hash: datasetContentHash,
			gate_context: "ci",
			definition_contract: "legacy_incompatible",
			status: "active",
			revoked_at: null,
		});
		expect(result.items[0]!.definition_content_hash).toMatch(/^[a-f0-9]{64}$/);
		expect(result.items[0]!.dataset_content_hash).toMatch(/^[a-f0-9]{64}$/);

		await expect(
			admitEvaluationGate(db as never, {
				project_id: projectId,
				approval_id: approvalId,
				definition_version_id: definitionVersionId,
				dataset_version_id: datasetVersionId,
				gate_context: "ci",
				idempotency_key: "fresh-legacy-key",
				authorization: {
					organization_id: organizationId,
					actor_id: actorId,
					operation: "release_gate_manage",
				},
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			status: 400,
			message:
				"The selected Definition Version is not an executable v1 contract",
		});
		expect(
			db.calls.some((text) =>
				text.includes("definition.evaluator AS definition_evaluator"),
			),
		).toBe(true);
		expect(
			db.calls.some((text) => text.includes("FOR UPDATE OF approval")),
		).toBe(true);
		expect(
			db.calls.some((text) =>
				text.includes("FROM evaluation_definition_versions definition"),
			),
		).toBe(true);
		expect(
			db.calls.filter((text) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)),
		).toEqual([]);
		expect(db.calls.at(-1)).toBe("ROLLBACK");
	});
});

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
		).rejects.toMatchObject({
			code: "CONFLICT",
			message:
				"Evaluation Gate approval is not active or is not available to this Project",
		});
		expect(
			db.calls.some((text) => text.includes("approval.revoked_at IS NULL")),
		).toBe(true);
		expect(
			db.calls.some((text) => text.startsWith("INSERT INTO evaluation_runs")),
		).toBe(false);
	});
});
