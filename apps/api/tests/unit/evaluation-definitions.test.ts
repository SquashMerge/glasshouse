import { describe, expect, it } from "bun:test";
import {
	definitionHash,
	getEvaluationDraft,
	getEvaluationVersion,
	listEvaluationLegacyLinks,
	publishEvaluationDraft,
	transitionEvaluationLifecycle,
	updateEvaluationDraft,
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
	it("reads a 0074 draft after 0075 as incomplete and requires a complete replacement before publish", async () => {
		const legacy = {
			evaluation_id: "33333333-3333-4333-8333-333333333333",
			project_id: "44444444-4444-4444-8444-444444444444",
			revision: 1,
			updated_at: new Date("2026-01-01T00:00:00.000Z"),
			dataset_version_id: definition.dataset_version_id,
			sampling: { strategy: "first_n", sample_size: 100, seed: 0 },
			evaluator: { kind: "exact_match", version: "v1" },
			target: { kind: "configured_llm" },
			execution_defaults: {},
			limits: { max_cost_usd: 10, max_duration_seconds: 3600 },
			thresholds: {},
		};
		const typed = { ...legacy, ...definition, revision: 2 };
		const published = {
			id: "22222222-2222-4222-8222-222222222222",
			...typed,
			version: 1,
			content_hash: definitionHash(definition),
			published_by: "66666666-6666-4666-8666-666666666666",
			published_draft_revision: 2,
			created_at: legacy.updated_at,
		};
		let draftRow = legacy;
		const queries: string[] = [];
		const client = {
			query: async (sql: string) => {
				queries.push(sql);
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.startsWith("SELECT p.id FROM projects"))
					return { rows: [{ id: legacy.project_id }] };
				if (sql.startsWith("SELECT d.* FROM evaluation_definition_drafts"))
					return { rows: [draftRow] };
				if (sql.startsWith("UPDATE evaluation_definition_drafts")) {
					draftRow = typed;
					return { rows: [typed] };
				}
				if (sql.startsWith("SELECT v.*")) return { rows: [] };
				if (sql.startsWith("INSERT INTO evaluation_definition_versions"))
					return { rows: [published] };
				return { rows: [] };
			},
			release() {},
		};
		const input = {
			project_id: legacy.project_id,
			slug: "legacy-evaluation",
			authorization: {
				organization_id: "55555555-5555-4555-8555-555555555555",
				actor_id: "66666666-6666-4666-8666-666666666666",
				operation: "curation_write" as const,
			},
		};
		const draft = await getEvaluationDraft(
			{ connect: async () => client } as never,
			input,
		);
		expect(draft).toMatchObject({
			definition_contract: "legacy_incomplete",
			evaluator: legacy.evaluator,
			target: legacy.target,
			execution_defaults: legacy.execution_defaults,
			thresholds: legacy.thresholds,
		});
		await expect(
			publishEvaluationDraft({ connect: async () => client } as never, {
				...input,
				revision: legacy.revision,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"Evaluation draft must be replaced with a complete typed Definition before publishing",
		});
		expect(
			queries.some((sql) =>
				sql.startsWith("INSERT INTO evaluation_definition_versions"),
			),
		).toBe(false);
		const updated = await updateEvaluationDraft(
			{ connect: async () => client } as never,
			{ ...input, revision: legacy.revision, definition },
		);
		expect(updated).toMatchObject({ definition_contract: "v1", revision: 2 });
		const result = await publishEvaluationDraft(
			{ connect: async () => client } as never,
			{ ...input, revision: updated.revision },
		);
		expect(result).toMatchObject({ definition_contract: "v1", version: 1 });
		expect(
			queries.some((sql) =>
				sql.startsWith("INSERT INTO evaluation_definition_versions"),
			),
		).toBe(true);
	});
	it("publishes an immutable version without draft-only serialization fields", async () => {
		const published = {
			id: "22222222-2222-4222-8222-222222222222",
			evaluation_id: "33333333-3333-4333-8333-333333333333",
			project_id: "44444444-4444-4444-8444-444444444444",
			...definition,
			version: 1,
			content_hash: definitionHash(definition),
			published_by: "66666666-6666-4666-8666-666666666666",
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
				if (sql.startsWith("SELECT d.* FROM evaluation_definition_drafts"))
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
				slug: "evaluation",
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
		expect(result).toHaveProperty("definition_contract", "v1");
	});
	it("serializes pre-contract versions as their exact immutable legacy snapshot", async () => {
		const legacy = {
			id: "22222222-2222-4222-8222-222222222222",
			evaluation_id: "33333333-3333-4333-8333-333333333333",
			project_id: "44444444-4444-4444-8444-444444444444",
			version: 1,
			dataset_version_id: "11111111-1111-4111-8111-111111111111",
			evaluator: { kind: "exact_match" },
			target: { kind: "configured_llm" },
			execution_defaults: {},
			thresholds: {},
			sampling: null,
			limits: null,
			content_hash: "b".repeat(64),
			published_by: "66666666-6666-4666-8666-666666666666",
			published_draft_revision: 1,
			created_at: new Date("2026-01-01T00:00:00.000Z"),
		};
		const result = await getEvaluationVersion(
			{
				connect: async () => ({
					query: async (sql: string) => {
						if (sql.startsWith("SELECT authorization_allows_project"))
							return { rows: [{ allowed: true }] };
						if (sql.startsWith("SELECT p.id FROM projects"))
							return { rows: [{ id: legacy.project_id }] };
						return { rows: [legacy] };
					},
					release() {},
				}),
			} as never,
			{
				project_id: legacy.project_id,
				slug: "legacy-evaluation",
				version: 1,
				authorization: {
					organization_id: "55555555-5555-4555-8555-555555555555",
					actor_id: "66666666-6666-4666-8666-666666666666",
					operation: "product_read",
				},
			},
		);
		expect(result).toMatchObject({
			definition_contract: "legacy_untyped",
			evaluator: legacy.evaluator,
			sampling: null,
			limits: null,
			content_hash: legacy.content_hash,
		});
		expect(result.evaluator).not.toHaveProperty("version");
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
	it("archives only at the current lifecycle revision and retains an audit event", async () => {
		const queries: string[] = [];
		const result = await transitionEvaluationLifecycle(
			{
				connect: async () => ({
					query: async (sql: string) => {
						queries.push(sql);
						if (sql.startsWith("SELECT authorization_allows_project"))
							return { rows: [{ allowed: true }] };
						if (sql.startsWith("SELECT p.id FROM projects"))
							return { rows: [{ id: "project" }] };
						if (sql.startsWith("UPDATE evaluations"))
							return {
								rows: [
									{
										id: "evaluation",
										project_id: "project",
										slug: "quality",
										name: "Quality",
										description: null,
										lifecycle_revision: 2,
										archived_at: new Date(),
										tombstoned_at: null,
										created_at: new Date(),
										updated_at: new Date(),
									},
								],
							};
						return { rows: [] };
					},
					release() {},
				}),
			} as never,
			{
				project_id: "project",
				slug: "quality",
				revision: 1,
				action: "archive",
				authorization: {
					organization_id: "organization",
					actor_id: "actor",
					operation: "destructive",
				},
			},
		);
		expect(result.lifecycle_revision).toBe(2);
		expect(queries.some((sql) => sql.includes("archived_at IS NULL"))).toBe(
			true,
		);
		expect(queries.some((sql) => sql.includes("'archived'"))).toBe(false);
	});
	it("reads post-migration legacy experiments directly without inventing evidence", async () => {
		const queries: string[] = [];
		const result = await listEvaluationLegacyLinks(
			{
				connect: async () => ({
					query: async (sql: string) => {
						queries.push(sql);
						if (sql.startsWith("SELECT authorization_allows_project"))
							return { rows: [{ allowed: true }] };
						if (sql.startsWith("SELECT p.id FROM projects"))
							return { rows: [{ id: "project" }] };
						return {
							rows: [
								{
									legacy_kind: "experiment",
									legacy_id: "22222222-2222-4222-8222-222222222222",
									dataset_id: "33333333-3333-4333-8333-333333333333",
									created_at: "2026-01-01T00:00:00.000Z",
								},
							],
						};
					},
					release() {},
				}),
			} as never,
			{
				project_id: "project",
				authorization: {
					organization_id: "organization",
					actor_id: "actor",
					operation: "product_read",
				},
			},
		);
		expect(result.items[0]).toMatchObject({
			compatibility: "legacy_ad_hoc",
			legacy_kind: "experiment",
		});
		expect(
			queries.some((query) =>
				query.includes("FROM experiments WHERE project_id=$1"),
			),
		).toBe(true);
	});
});
