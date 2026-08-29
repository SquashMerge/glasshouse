import { describe, expect, it, spyOn } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { getEvaluation } from "../../src/db/evaluations";
import * as postgres from "../../src/db/postgres";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";
import {
	createEvaluationRoute,
	archiveEvaluationRoute,
	restoreEvaluationRoute,
	tombstoneEvaluationRoute,
	getEvaluationDraftRoute,
	getEvaluationRoute,
	getEvaluationVersionRoute,
	handleCreateEvaluation,
	handleArchiveEvaluation,
	handleRestoreEvaluation,
	handleTombstoneEvaluation,
	handleGetEvaluation,
	handleGetEvaluationDraft,
	handleGetEvaluationVersion,
	handleListEvaluations,
	handleListEvaluationVersions,
	handlePublishEvaluationDraft,
	handlePutEvaluationDraft,
	listEvaluationLegacyLinksRoute,
	listEvaluationsRoute,
	listEvaluationVersionsRoute,
	publishEvaluationDraftRoute,
	putEvaluationDraftRoute,
} from "../../src/routes/evaluations";
import {
	EvaluationDefinitionInput,
	EvaluationDefinitionVersion,
	EvaluationDraft,
	EvaluationCreate,
	EvaluationListQuery,
	EvaluationSlugParam,
} from "../../src/schemas/evaluations";

const projectId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const definition = {
	dataset_version_id: "55555555-5555-4555-8555-555555555555",
	sampling: { strategy: "first_n", sample_size: 100, seed: 0 },
	evaluator: {
		kind: "exact_match",
		version: "v1",
		expected_output_path: "$.expected_output",
		output_path: "$.output",
	},
	target: {
		kind: "configured_llm",
		model: "model",
		system_prompt: null,
	},
	execution_defaults: { temperature: 0, max_tokens: null },
	limits: { max_cost_usd: 10, max_duration_seconds: 3600 },
	thresholds: { minimum_pass_rate: null },
};

describe("evaluation route contract", () => {
	it("strictly parses include_archived query values", () => {
		expect(EvaluationListQuery.parse({ project_id: projectId })).toEqual({
			project_id: projectId,
			include_archived: false,
		});
		expect(
			EvaluationListQuery.parse({
				project_id: projectId,
				include_archived: "true",
			}),
		).toMatchObject({ include_archived: true });
		expect(
			EvaluationListQuery.parse({
				project_id: projectId,
				include_archived: "false",
			}),
		).toMatchObject({ include_archived: false });
		expect(
			EvaluationListQuery.safeParse({
				project_id: projectId,
				include_archived: "yes",
			}).success,
		).toBe(false);
	});
	it("passes only strict include_archived values to the list route", async () => {
		const parsedQueries: Array<{
			project_id: string;
			include_archived: boolean;
		}> = [];
		const app = new OpenAPIHono({
			defaultHook: (result, c) =>
				result.success
					? undefined
					: c.json(
							{ code: "BAD_REQUEST", message: "Request validation failed" },
							400,
						),
		});
		app.openapi(listEvaluationsRoute, (c) => {
			parsedQueries.push(c.req.valid("query"));
			return c.json({ items: [], total: 0 });
		});

		for (const [suffix, include_archived] of [
			["", false],
			["&include_archived=true", true],
			["&include_archived=false", false],
		] as const) {
			const response = await app.request(
				`http://test/v1/evaluations?project_id=${projectId}${suffix}`,
			);
			expect(response.status).toBe(200);
			expect(parsedQueries.at(-1)).toEqual({
				project_id: projectId,
				include_archived,
			});
		}

		const invalid = await app.request(
			`http://test/v1/evaluations?project_id=${projectId}&include_archived=yes`,
		);
		expect(invalid.status).toBe(400);
		expect(parsedQueries).toHaveLength(3);
	});
	it("rejects UUID-shaped slugs while retaining UUID Evaluation detail IDs", async () => {
		const evaluationId = "44444444-4444-4444-8444-444444444444";
		const now = new Date("2026-08-29T00:00:00.000Z");
		const queries: string[] = [];
		const query = async (sql: string) => {
			queries.push(sql);
			if (sql.startsWith("SELECT p.id FROM projects"))
				return { rows: [{ id: projectId }] };
			if (sql.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			if (sql.startsWith("SELECT * FROM evaluations"))
				return {
					rows: [
						{
							id: evaluationId,
							project_id: projectId,
							slug: "stable-evaluation",
							name: "Stable Evaluation",
							description: null,
							lifecycle_revision: 1,
							archived_at: null,
							tombstoned_at: null,
							created_at: now,
							updated_at: now,
						},
					],
				};
			return { rows: [] };
		};

		const value = await getEvaluation(
			{ connect: async () => ({ query, release() {} }) } as never,
			{
				project_id: projectId,
				slug: evaluationId,
				authorization: {
					organization_id: organizationId,
					actor_id: actorId,
					operation: "product_read",
				},
			},
		);

		expect(value).toMatchObject({
			id: evaluationId,
			slug: "stable-evaluation",
		});
		const detailQuery = queries.find((sql) =>
			sql.startsWith("SELECT * FROM evaluations"),
		);
		expect(detailQuery).toContain(
			"CASE WHEN $1 ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN id::text=$1 ELSE slug=$1 END",
		);
		expect(
			EvaluationCreate.safeParse({
				slug: evaluationId,
				name: "UUID-shaped slug",
				definition,
			}).success,
		).toBe(false);
		expect(EvaluationSlugParam.safeParse({ slug: evaluationId }).success).toBe(
			true,
		);
	});
	it("reserves compatibility for the static legacy-link route", async () => {
		expect(
			EvaluationCreate.safeParse({
				slug: "compatibility",
				name: "Compatibility",
				definition,
			}).success,
		).toBe(false);

		let detailCalls = 0;
		const app = new OpenAPIHono({
			defaultHook: (result, c) =>
				result.success
					? undefined
					: c.json(
							{ code: "BAD_REQUEST", message: "Request validation failed" },
							400,
						),
		});
		app.openapi(listEvaluationLegacyLinksRoute, (c) => c.json({ items: [] }));
		app.openapi(getEvaluationRoute, (c) => {
			detailCalls += 1;
			return c.json({ path: c.req.path });
		});

		const response = await app.request(
			`http://test/v1/evaluations/compatibility?project_id=${projectId}`,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ items: [] });
		expect(detailCalls).toBe(0);
	});
	it("returns non-enumerating 404s for archived Evaluation direct reads", async () => {
		const queries: string[] = [];
		const now = new Date("2026-08-29T00:00:00.000Z");
		const evaluationId = "44444444-4444-4444-8444-444444444444";
		const archivedEvaluation = {
			id: evaluationId,
			project_id: projectId,
			slug: "archived-evaluation",
			name: "Archived evaluation",
			description: null,
			lifecycle_revision: 2,
			archived_at: now,
			tombstoned_at: null,
			created_at: now,
			updated_at: now,
		};
		const archivedDraft = {
			...definition,
			evaluation_id: evaluationId,
			project_id: projectId,
			revision: 1,
			updated_at: now,
		};
		const archivedVersion = {
			...definition,
			id: "66666666-6666-4666-8666-666666666666",
			evaluation_id: evaluationId,
			project_id: projectId,
			version: 1,
			content_hash: "a".repeat(64),
			published_draft_revision: 1,
			created_at: now,
		};
		const query = async (sql: string) => {
			queries.push(sql);
			if (sql.startsWith("SELECT p.id FROM projects"))
				return { rows: [{ id: projectId }] };
			if (sql.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			if (sql.startsWith("SELECT * FROM evaluations"))
				return {
					rows: sql.includes("archived_at IS NULL") ? [] : [archivedEvaluation],
				};
			if (sql.startsWith("SELECT d.* FROM evaluation_definition_drafts"))
				return {
					rows: sql.includes("e.archived_at IS NULL") ? [] : [archivedDraft],
				};
			if (sql.startsWith("SELECT d.revision FROM evaluation_definition_drafts"))
				return {
					rows: sql.includes("e.archived_at IS NULL") ? [] : [{ revision: 1 }],
				};
			if (sql.startsWith("SELECT v.* FROM evaluation_definition_versions"))
				return {
					rows: sql.includes("e.archived_at IS NULL") ? [] : [archivedVersion],
				};
			if (sql.startsWith("SELECT 1 FROM evaluations"))
				return {
					rows: sql.includes("archived_at IS NULL") ? [] : [{ exists: 1 }],
				};
			return { rows: [] };
		};
		const postgresSpy = spyOn(postgres, "pgPool").mockReturnValue({
			connect: async () => ({ query, release() {} }),
		} as never);
		const app = new OpenAPIHono({
			defaultHook: (result, c) =>
				result.success
					? undefined
					: c.json(
							{ code: "BAD_REQUEST", message: "Request validation failed" },
							400,
						),
		});
		app.use("/v1/*", async (c, next) => {
			c.set(TRUSTED_TENANT_CONTEXT_KEY, {
				actor: "reader",
				actorId,
				organizationId,
			});
			await next();
		});
		app.openapi(getEvaluationRoute, handleGetEvaluation);
		app.openapi(getEvaluationDraftRoute, handleGetEvaluationDraft);
		app.openapi(putEvaluationDraftRoute, handlePutEvaluationDraft);
		app.openapi(listEvaluationVersionsRoute, handleListEvaluationVersions);
		app.openapi(getEvaluationVersionRoute, handleGetEvaluationVersion);

		try {
			for (const [path, statement] of [
				["/v1/evaluations/archived-evaluation", "SELECT * FROM evaluations"],
				[
					"/v1/evaluations/archived-evaluation/draft",
					"SELECT d.* FROM evaluation_definition_drafts",
				],
				[
					"/v1/evaluations/archived-evaluation/versions",
					"SELECT v.* FROM evaluation_definition_versions",
				],
				[
					"/v1/evaluations/archived-evaluation/versions/1",
					"SELECT v.* FROM evaluation_definition_versions",
				],
			] as const) {
				queries.length = 0;
				const response = await app.request(
					`http://test${path}?project_id=${projectId}`,
				);

				expect(response.status).toBe(404);
				expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
				const query = queries.find((sql) => sql.startsWith(statement));
				expect(query).toContain("archived_at IS NULL");
			}

			queries.length = 0;
			const update = await app.request(
				`http://test/v1/evaluations/archived-evaluation/draft?project_id=${projectId}`,
				{
					method: "PUT",
					headers: {
						"content-type": "application/json",
						"if-match": '"1"',
					},
					body: JSON.stringify(definition),
				},
			);
			expect(update.status).toBe(404);
			expect(await update.json()).toMatchObject({ code: "NOT_FOUND" });
			const fallback = queries.find((sql) =>
				sql.startsWith("SELECT d.revision FROM evaluation_definition_drafts"),
			);
			expect(fallback).toContain("e.archived_at IS NULL");
		} finally {
			postgresSpy.mockRestore();
		}
	});
	it("documents query-scoped create and slug-scoped draft and version paths", () => {
		const app = new OpenAPIHono();
		app.openapi(createEvaluationRoute, handleCreateEvaluation);
		app.openapi(archiveEvaluationRoute, handleArchiveEvaluation);
		app.openapi(restoreEvaluationRoute, handleRestoreEvaluation);
		app.openapi(tombstoneEvaluationRoute, handleTombstoneEvaluation);
		app.openapi(getEvaluationRoute, handleGetEvaluation);
		app.openapi(getEvaluationDraftRoute, handleGetEvaluationDraft);
		app.openapi(putEvaluationDraftRoute, handlePutEvaluationDraft);
		app.openapi(publishEvaluationDraftRoute, handlePublishEvaluationDraft);
		app.openapi(listEvaluationsRoute, handleListEvaluations);
		app.openapi(listEvaluationVersionsRoute, handleListEvaluationVersions);
		app.openapi(getEvaluationVersionRoute, handleGetEvaluationVersion);
		const document = app.getOpenAPIDocument({
			openapi: "3.0.0",
			info: { title: "test", version: "1" },
		});
		expect(
			document.paths?.["/v1/evaluations"]?.post?.parameters,
		).toContainEqual(
			expect.objectContaining({
				name: "project_id",
				in: "query",
				required: true,
			}),
		);
		expect(document.paths?.["/v1/evaluations/{slug}/draft"]?.put).toBeDefined();
		expect(
			document.paths?.["/v1/evaluations/{slug}/versions/{version}"]?.get,
		).toBeDefined();
		expect(document.paths?.["/v1/evaluations/{id}/draft"]).toBeUndefined();
		expect(document.paths?.["/v1/evaluations/{slug}"]?.delete).toBeDefined();
		expect(
			document.paths?.["/v1/evaluations/{slug}/tombstone"]?.delete,
		).toBeDefined();
	});
	it("documents legacy immutable snapshots without fabricating the typed contract", () => {
		expect(
			EvaluationDefinitionVersion.safeParse({
				id: "11111111-1111-4111-8111-111111111111",
				evaluation_id: "22222222-2222-4222-8222-222222222222",
				project_id: "33333333-3333-4333-8333-333333333333",
				version: 1,
				dataset_version_id: "44444444-4444-4444-8444-444444444444",
				definition_contract: "legacy_untyped",
				sampling: null,
				evaluator: { kind: "exact_match" },
				target: { kind: "configured_llm" },
				execution_defaults: {},
				limits: null,
				thresholds: {},
				content_hash: "b".repeat(64),
				published_draft_revision: 1,
				created_at: "2026-01-01T00:00:00.000Z",
			}).success,
		).toBe(true);
	});
	it("documents upgraded incomplete drafts separately from the typed replacement contract", () => {
		const upgradedLegacyDraft = {
			dataset_version_id: "44444444-4444-4444-8444-444444444444",
			sampling: { strategy: "first_n", sample_size: 100, seed: 0 },
			evaluator: { kind: "exact_match", version: "v1" },
			target: { kind: "configured_llm" },
			execution_defaults: {},
			limits: { max_cost_usd: 10, max_duration_seconds: 3600 },
			thresholds: {},
		};
		expect(
			EvaluationDraft.safeParse({
				...upgradedLegacyDraft,
				evaluation_id: "11111111-1111-4111-8111-111111111111",
				project_id: "22222222-2222-4222-8222-222222222222",
				revision: 1,
				updated_at: "2026-01-01T00:00:00.000Z",
				definition_contract: "legacy_incomplete",
			}).success,
		).toBe(true);
		expect(
			EvaluationDefinitionInput.safeParse(upgradedLegacyDraft).success,
		).toBe(true);
		expect(
			EvaluationDefinitionInput.safeParse({
				...upgradedLegacyDraft,
				evaluator: {
					...upgradedLegacyDraft.evaluator,
					expected_output_path: "$.expected_output",
					output_path: "$.output",
				},
				target: {
					...upgradedLegacyDraft.target,
					model: null,
					system_prompt: null,
				},
				execution_defaults: { temperature: 0, max_tokens: null },
				thresholds: { minimum_pass_rate: null },
			}).success,
		).toBe(true);
	});
});
