import { describe, expect, it } from "bun:test";
import {
	definitionHash,
	publishEvaluationDraft,
} from "../../src/db/evaluations";
import { EvaluationDefinitionInput } from "../../src/schemas/evaluations";

const definition = {
	dataset_version_id: "11111111-1111-4111-8111-111111111111",
	sampling: { strategy: "first_n" as const, sample_size: 100, seed: 0 },
	evaluator: {
		kind: "exact_match" as const,
		version: "v1" as const,
		expected_output_path: "$.expected_output",
		output_path: "$.output",
	},
	target: {
		kind: "configured_llm" as const,
		model: "model",
		system_prompt: "secret prompt",
	},
	execution_defaults: { temperature: 0, max_tokens: null },
	limits: { max_cost_usd: 10, max_duration_seconds: 3600 },
	thresholds: { minimum_pass_rate: 0.9 },
};

describe("Evaluation definitions", () => {
	it("has a stable canonical hash independent of object key order", () => {
		expect(definitionHash(definition)).toBe(
			definitionHash({
				...definition,
				evaluator: {
					output_path: "$.output",
					kind: "exact_match",
					version: "v1",
					expected_output_path: "$.expected_output",
				},
			}),
		);
	});
	it("rejects executable and untyped evaluator configuration", () => {
		expect(
			EvaluationDefinitionInput.safeParse({
				...definition,
				evaluator: { ...definition.evaluator, code: "return true" },
			}).success,
		).toBe(false);
		expect(
			EvaluationDefinitionInput.safeParse({
				...definition,
				target: { kind: "arbitrary_url" },
			}).success,
		).toBe(false);
	});
	it("requires deterministic sampling, evaluator version, and bounded limits", () => {
		for (const invalid of [
			{ ...definition, sampling: undefined },
			{ ...definition, evaluator: { ...definition.evaluator, version: "v2" } },
			{ ...definition, limits: { max_cost_usd: 0, max_duration_seconds: 1 } },
		])
			expect(EvaluationDefinitionInput.safeParse(invalid).success).toBe(false);
	});
	it("publishes an immutable version without draft-only serialization fields", async () => {
		const published = {
			id: "22222222-2222-4222-8222-222222222222",
			evaluation_id: "33333333-3333-4333-8333-333333333333",
			project_id: "44444444-4444-4444-8444-444444444444",
			...definition,
			version: 1,
			content_hash: definitionHash(definition),
			published_draft_revision: 1,
			created_at: new Date("2026-01-01T00:00:00.000Z"),
		};
		const draft = {
			...published,
			revision: 1,
			updated_at: published.created_at,
		};
		const client = {
			query: async (sql: string) => {
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.startsWith("SELECT p.id FROM projects"))
					return { rows: [{ id: published.project_id }] };
				if (sql.startsWith("SELECT * FROM evaluation_definition_drafts"))
					return { rows: [draft] };
				if (sql.startsWith("SELECT v.*")) return { rows: [] };
				if (sql.startsWith("INSERT INTO evaluation_definition_versions"))
					return { rows: [published] };
				return { rows: [] };
			},
			release() {},
		};
		const result = await publishEvaluationDraft(
			{ connect: async () => client } as never,
			{
				project_id: published.project_id,
				id: published.evaluation_id,
				revision: 1,
				authorization: {
					organization_id: "55555555-5555-4555-8555-555555555555",
					actor_id: "66666666-6666-4666-8666-666666666666",
					operation: "curation_write",
				},
			},
		);
		expect(result).toMatchObject({ id: published.id, version: 1 });
		expect(result).not.toHaveProperty("revision");
		expect(result).not.toHaveProperty("updated_at");
	});
	it("keeps target content out of audit payload contracts", () => {
		expect(Object.keys(definition)).toContain("target");
		expect([
			"project_id",
			"evaluation_id",
			"actor_id",
			"event_type",
			"definition_version_id",
			"content_hash",
		]).not.toContain("target");
	});
});
