import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
	addDatasetItem,
	authorizeDatasetWrite,
	createDataset,
	DatasetRepositoryError,
	deleteDatasetDraftItem,
	deleteDatasetItem,
	getDatasetBySlug,
	getDatasetDraft,
	getOrCreateDatasetDraft,
	getDataset,
	listDatasetItems,
	listPublishedDatasetItems,
	listDatasets,
	upsertDatasetDraftItem,
	updateDatasetMetadata,
} from "../../src/db/datasets";
import {
	deleteDatasetItem as deleteDatasetItemRoute,
	deleteDatasetDraftItem as deleteDatasetDraftItemRoute,
	createDatasetDraft,
	createDatasetRouteHandlers,
	getDatasetDraft as getDatasetDraftRoute,
	handleCreateDatasetDraft,
	handleGetDatasetDraft,
	handlePutDatasetDraftItem,
	handleDeleteDatasetDraftItem,
	putDatasetDraftItem,
} from "../../src/routes/datasets";
import {
	DatasetCreate,
	DatasetDraftItemParam,
	DatasetDraftItemUpsert,
	DatasetDraftItem,
	DatasetItem,
	DatasetItemCreate,
} from "../../src/schemas/datasets";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const DATASET = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-27T22:00:00.000Z");
const authorization = {
	organization_id: "00000000-0000-4000-8000-000000000001",
	actor_id: "44444444-4444-4444-8444-444444444444",
	operation: "product_write" as const,
};

const datasetRow = {
	id: DATASET,
	project_id: PROJECT,
	slug: "golden",
	name: "golden",
	description: null,
	tags: [],
	latest_published_version: 1,
	archived_at: null,
	item_count: 0,
	created_at: NOW,
	updated_at: NOW,
};

function fakeDb(
	responses: Array<{ rows?: Record<string, unknown>[]; rowCount?: number }>,
) {
	const queries: Array<{ text: string; values?: unknown[] }> = [];
	const db = {
		queries,
		query: async (text: string, values?: unknown[]) => {
			queries.push({ text, values });
			if (text.includes("p.status = ANY($3::text[])"))
				return responses.shift() ?? { rows: [{ id: PROJECT }] };
			if (text.includes("FROM organization_memberships om"))
				return { rows: [{ actor_subject: "writer" }] };
			if (text.includes("FROM organization_actor_roles"))
				return { rows: [{ actor_id: authorization.actor_id }] };
			if (text.includes("FROM project_memberships pm"))
				return { rows: [{ actor_subject: "writer" }] };
			if (text.includes("FROM project_actor_grants"))
				return { rows: [{ actor_id: authorization.actor_id }] };
			if (text.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			return responses.shift() ?? { rows: [], rowCount: 0 };
		},
	};
	const pool = db as typeof db & {
		connect: () => Promise<typeof db & { release: () => void }>;
	};
	pool.connect = async () => ({ ...pool, release() {} });
	return pool;
}

describe("dataset contracts", () => {
	it("requires a project boundary when creating a dataset item", () => {
		expect(
			DatasetItemCreate.safeParse({ input: { question: "hello" } }).success,
		).toBe(false);
	});

	it("accepts trace provenance on dataset items", () => {
		const result = DatasetItemCreate.safeParse({
			project_id: PROJECT,
			input: { question: "hello" },
			expected_output: { answer: "world" },
			source_trace_id: "a".repeat(32),
			source_observation_id: "b".repeat(16),
		});
		expect(result.success).toBe(true);
	});

	it("rejects observation provenance without its trace", () => {
		expect(
			DatasetItemCreate.safeParse({
				project_id: PROJECT,
				input: { question: "hello" },
				source_observation_id: "b".repeat(16),
			}).success,
		).toBe(false);
	});

	it("rejects a dataset item with an invalid project id", () => {
		expect(
			DatasetCreate.safeParse({ project_id: "not-a-uuid", name: "golden" })
				.success,
		).toBe(false);
	});

	it("models persisted provenance as nullable", () => {
		const result = DatasetItem.safeParse({
			id: "33333333-3333-4333-8333-333333333333",
			dataset_id: DATASET,
			input: {},
			expected_output: null,
			metadata: {},
			source_trace_id: null,
			source_observation_id: null,
			created_at: NOW.toISOString(),
		});
		expect(result.success).toBe(true);
	});

	it("accepts a stable dataset slug and draft item key", () => {
		expect(
			DatasetCreate.safeParse({
				project_id: PROJECT,
				slug: "golden-suite",
				name: "Golden",
			}).success,
		).toBe(true);
		expect(
			DatasetCreate.safeParse({
				project_id: PROJECT,
				slug: "Golden",
				name: "Golden",
			}).success,
		).toBe(false);
		expect(
			DatasetDraftItemParam.safeParse({
				slug: "golden-suite",
				itemKey: "stable-key",
			}).success,
		).toBe(true);
		expect(
			DatasetDraftItemUpsert.safeParse({
				input: { question: "hello" },
				metadata: { source: "test" },
			}).success,
		).toBe(true);
	});
});

describe("dataset repository", () => {
	it("lists only datasets for the requested project", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [datasetRow], rowCount: 1 },
		]);
		const result = await listDatasets(db, {
			project_id: PROJECT,
			authorization: { ...authorization, operation: "product_read" },
		});
		expect(result.items[0]?.id).toBe(DATASET);
		const listQuery = db.queries.find((query) =>
			query.text.includes("WHERE d.project_id = $1"),
		);
		expect(listQuery?.values).toEqual([PROJECT]);
	});

	it("looks up stable slugs within the requested project", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [datasetRow], rowCount: 1 },
		]);
		await expect(
			getDatasetBySlug(db, {
				project_id: PROJECT,
				slug: "golden",
				authorization,
			}),
		).resolves.toMatchObject({ slug: "golden" });
		expect(
			db.queries.some((query) =>
				query.text.includes("authorization_allows_project"),
			),
		).toBe(true);
		expect(
			db.queries.some((query) =>
				query.text.includes("d.project_id = $1 AND d.slug = $2"),
			),
		).toBe(true);
		expect(
			db.queries.some((query) =>
				query.text.includes("dataset_lifecycle_audit_events"),
			),
		).toBe(false);
	});

	it("fences every dataset read through the active authorized project lock", () => {
		for (const operation of [
			getDatasetBySlug,
			getDatasetDraft,
			listDatasets,
			getDataset,
			listDatasetItems,
		])
			expect(operation.toString()).toContain("lockActiveAuthorizedProject");
	});

	it("keeps draft-visible items separate from published execution items", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [datasetRow] },
			{ rows: [] },
		]);
		await listPublishedDatasetItems(db, {
			project_id: PROJECT,
			dataset_id: DATASET,
			authorization,
		});
		const query = db.queries.find((entry) =>
			entry.text.includes("FROM dataset_version_items"),
		);
		expect(query?.text).not.toContain("dataset_draft_items");
	});

	it("serializes draft items to the exact public schema without persisted fields", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [{ id: "draft", dataset_id: DATASET, revision: 1 }] },
			{
				rows: [
					{
						id: "private",
						project_id: PROJECT,
						draft_id: "draft",
						item_key: "stable",
						position: 0,
						input: '{"question":"hello"}',
						expected_output: null,
						metadata: '{"source":"test"}',
						source_trace_id: "trace",
						created_at: NOW,
					},
				],
			},
		]);
		const result = await upsertDatasetDraftItem(db, {
			project_id: PROJECT,
			slug: "golden",
			item_key: "stable",
			revision: 1,
			input: { question: "hello" },
			authorization,
		});
		expect(DatasetDraftItem.safeParse(result).success).toBe(true);
		expect(result).toEqual({
			item_key: "stable",
			input: { question: "hello" },
			expected_output: null,
			metadata: { source: "test" },
			source_trace_id: "trace",
			source_observation_id: null,
			position: 0,
		});
	});

	it("returns the actual metadata item count", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [] },
			{ rows: [{ ...datasetRow, item_count: 3 }] },
		]);
		await expect(
			updateDatasetMetadata(db, {
				project_id: PROJECT,
				slug: "golden",
				name: "Golden updated",
				authorization,
			}),
		).resolves.toMatchObject({ item_count: 3 });
		expect(
			db.queries.some((query) =>
				query.text.includes(
					"dataset_versions v WHERE v.dataset_id = datasets.id",
				),
			),
		).toBe(true);
		const audits = db.queries.filter((query) =>
			query.text.includes("dataset_lifecycle_audit_events"),
		);
		expect(audits).toHaveLength(1);
		expect(audits[0]?.text).toContain("'metadata_updated'");
		expect(audits[0]?.values).toEqual([
			authorization.organization_id,
			PROJECT,
			DATASET,
			"golden",
			authorization.actor_id,
		]);
	});

	it("creates a shared draft under the authorized project lock", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{
				rows: [
					{
						id: "55555555-5555-4555-8555-555555555555",
						project_id: PROJECT,
						dataset_id: DATASET,
						base_version: 1,
						revision: 1,
						item_count: 0,
						created_at: NOW,
						updated_at: NOW,
					},
				],
			},
		]);
		await expect(
			getOrCreateDatasetDraft(db, {
				project_id: PROJECT,
				slug: "golden",
				authorization,
			}),
		).resolves.toMatchObject({ revision: 1 });
		expect(
			db.queries.some((query) =>
				query.text.includes("ON CONFLICT (dataset_id)"),
			),
		).toBe(true);
	});

	it("maps duplicate dataset names to a conflict", async () => {
		const db = fakeDb([{ rows: [] }, { rows: [{ id: PROJECT }] }]);
		const query = db.query;
		db.query = async (text, values) => {
			if (text.startsWith("INSERT INTO datasets")) throw { code: "23505" };
			return query(text, values);
		};
		await expect(
			createDataset(db, { project_id: PROJECT, name: "golden", authorization }),
		).rejects.toMatchObject<DatasetRepositoryError>({
			code: "CONFLICT",
			status: 409,
		});
	});

	it("records creation evidence without dataset content", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [datasetRow] },
		]);
		await createDataset(db, {
			project_id: PROJECT,
			name: "Golden",
			description: "sensitive dataset content",
			authorization,
		});
		const audit = db.queries.find((query) =>
			query.text.includes("dataset_lifecycle_audit_events"),
		);
		expect(audit?.text).toContain("'created'");
		expect(audit?.values).toEqual([
			authorization.organization_id,
			PROJECT,
			DATASET,
			"golden",
			authorization.actor_id,
		]);
	});

	it("rejects legacy item mutations without changing published items or feedback links", async () => {
		const itemId = "33333333-3333-4333-8333-333333333333";
		const db = fakeDb([{ rows: [] }, { rows: [{ id: PROJECT }] }]);
		await expect(
			deleteDatasetItem(db, {
				project_id: PROJECT,
				dataset_id: DATASET,
				item_id: itemId,
				authorization,
			}),
		).rejects.toMatchObject<DatasetRepositoryError>({ code: "CONFLICT" });
		await expect(
			addDatasetItem(db, {
				project_id: PROJECT,
				dataset_id: DATASET,
				input: { question: "hello" },
				authorization,
			}),
		).rejects.toMatchObject<DatasetRepositoryError>({ code: "CONFLICT" });
		expect(
			db.queries.some(
				(query) =>
					query.text.startsWith("INSERT INTO dataset_items") ||
					query.text.startsWith("DELETE FROM dataset_items") ||
					query.text.startsWith("UPDATE feedback_reviews"),
			),
		).toBe(false);
	});

	it("locks and authorizes the active project before every dataset mutation", async () => {
		for (const operation of [
			createDataset,
			addDatasetItem,
			deleteDatasetItem,
			deleteDatasetDraftItem,
			authorizeDatasetWrite,
		])
			expect(operation.toString()).toContain("lockActiveAuthorizedProject");
	});

	it("deletes a draft item with its revision and records deletion provenance", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [{ id: "draft", dataset_id: DATASET, revision: 2 }] },
			{ rows: [{ id: "item" }] },
		]);
		await deleteDatasetDraftItem(db, {
			project_id: PROJECT,
			slug: "golden",
			item_key: "stable",
			revision: 2,
			authorization,
		});
		expect(
			db.queries.some((query) =>
				query.text.includes("DELETE FROM dataset_draft_items"),
			),
		).toBe(true);
		expect(
			db.queries.some((query) => query.text.includes("'draft_item_deleted'")),
		).toBe(true);
	});

	it("does not persist provenance copied from another project", async () => {
		let added = false;
		let checked: unknown;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			listDatasets: async () => ({ items: [], total: 0 }),
			createDataset: async () => datasetRow,
			getDataset: async () => datasetRow,
			listDatasetItems: async () => ({ items: [] }),
			addDatasetItem: async () => {
				added = true;
				return {
					id: "33333333-3333-4333-8333-333333333333",
					dataset_id: DATASET,
					input: {},
					expected_output: null,
					metadata: {},
					source_trace_id: "a".repeat(32),
					source_observation_id: null,
					created_at: NOW.toISOString(),
				};
			},
			deleteDatasetItem: async () => {},
			targetExists: async (input: unknown) => {
				checked = input;
				return false;
			},
		} as never);
		const response = await handlers.handleAddDatasetItem({
			get: () => ({
				actor: "test",
				organizationId: "00000000-0000-4000-8000-000000000001",
			}),
			req: {
				valid: (part: string) =>
					part === "param"
						? { id: DATASET }
						: {
								project_id: PROJECT,
								input: {},
								source_trace_id: "a".repeat(32),
								source_observation_id: "b".repeat(16),
							},
			},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);

		expect(response.status).toBe(409);
		expect(added).toBe(false);
		expect(checked).toBeUndefined();
	});

	it("rejects the legacy item route before checking or writing source provenance", async () => {
		let added = false;
		let checked = false;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			addDatasetItem: async () => {
				added = true;
				return {} as never;
			},
			targetExists: async () => {
				checked = true;
				return true;
			},
		} as never);
		const response = await handlers.handleAddDatasetItem({
			get: () => ({
				actor: "test",
				organizationId: authorization.organization_id,
			}),
			req: {
				valid: (part: string) =>
					part === "param"
						? { id: DATASET }
						: {
								project_id: PROJECT,
								input: {},
								source_trace_id: "a".repeat(32),
							},
			},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);
		expect(response.status).toBe(409);
		expect(added).toBe(false);
		expect(checked).toBe(false);
		const deletion = await handlers.handleDeleteDatasetItem({
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);
		expect(deletion.status).toBe(409);
	});

	it("documents draft ETags and the required If-Match revision", () => {
		const app = new OpenAPIHono();
		app.openapi(createDatasetDraft, handleCreateDatasetDraft);
		app.openapi(getDatasetDraftRoute, handleGetDatasetDraft);
		app.openapi(putDatasetDraftItem, handlePutDatasetDraftItem);
		app.openapi(deleteDatasetDraftItemRoute, handleDeleteDatasetDraftItem);
		const document = app.getOpenAPIDocument({
			openapi: "3.1.0",
			info: { title: "test", version: "1" },
		});
		for (const operation of [
			document.paths?.["/v1/datasets/by-slug/{slug}/drafts"]?.post,
			document.paths?.["/v1/datasets/by-slug/{slug}/draft"]?.get,
			document.paths?.["/v1/datasets/by-slug/{slug}/draft/items/{itemKey}"]
				?.put,
		])
			expect((operation as any).responses["200"].headers.ETag).toBeDefined();
		const put = document.paths?.[
			"/v1/datasets/by-slug/{slug}/draft/items/{itemKey}"
		]?.put as any;
		const remove = document.paths?.[
			"/v1/datasets/by-slug/{slug}/draft/items/{itemKey}"
		]?.delete as any;
		expect(remove.responses["204"].headers.ETag).toBeDefined();
		expect(remove.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					in: "header",
					name: "if-match",
					required: true,
				}),
			]),
		);
		expect(put.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					in: "header",
					name: "if-match",
					required: true,
				}),
			]),
		);
		app.openapi(deleteDatasetItemRoute, async () => new Response());
		const legacy = app.getOpenAPIDocument({
			openapi: "3.1.0",
			info: { title: "test", version: "1" },
		}).paths?.["/v1/datasets/{id}/items/{itemId}"]?.delete as any;
		expect(legacy.deprecated).toBe(true);
		expect(legacy.responses["204"]).toBeUndefined();
		expect(legacy.responses["409"]).toBeDefined();
	});

	it("returns only the documented draft item fields from the route", async () => {
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			authorizeDatasetWrite: async () => {},
			upsertDatasetDraftItem: async () => ({
				item_key: "stable",
				input: {},
				expected_output: null,
				metadata: {},
				position: 0,
			}),
		} as never);
		const response = await handlers.handlePutDatasetDraftItem({
			get: () => ({
				actor: "test",
				organizationId: authorization.organization_id,
				actorId: authorization.actor_id,
			}),
			req: {
				header: () => '"1"',
				valid: (part: string) =>
					part === "param"
						? { slug: "golden", itemKey: "stable" }
						: part === "query"
							? { project_id: PROJECT }
							: { input: {} },
			},
			header() {},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);
		expect(await response.json()).toEqual({
			item_key: "stable",
			input: {},
			expected_output: null,
			metadata: {},
			position: 0,
		});
	});

	it("rejects draft provenance outside the authorized project before writing", async () => {
		let written = false;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			authorizeDatasetWrite: async () => {},
			targetExists: async () => false,
			upsertDatasetDraftItem: async () => {
				written = true;
				return {} as never;
			},
		} as never);
		const response = await handlers.handlePutDatasetDraftItem({
			get: () => ({
				actor: "test",
				organizationId: authorization.organization_id,
				actorId: authorization.actor_id,
			}),
			req: {
				header: () => '"1"',
				valid: (part: string) =>
					part === "param"
						? { slug: "golden", itemKey: "stable" }
						: part === "query"
							? { project_id: PROJECT }
							: { input: {}, source_trace_id: "a".repeat(32) },
			},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);
		expect(response.status).toBe(404);
		expect(written).toBe(false);
	});

	it("authorizes draft writes before probing source provenance", async () => {
		let checked = false;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			authorizeDatasetWrite: async () => {
				throw new DatasetRepositoryError(
					"NOT_FOUND",
					"Project is not available",
				);
			},
			targetExists: async () => {
				checked = true;
				return true;
			},
		} as never);
		const response = await handlers.handlePutDatasetDraftItem({
			get: () => ({
				actor: "test",
				organizationId: authorization.organization_id,
			}),
			req: {
				header: () => '"1"',
				valid: (part: string) =>
					part === "param"
						? { slug: "golden", itemKey: "stable" }
						: part === "query"
							? { project_id: PROJECT }
							: { input: {}, source_trace_id: "a".repeat(32) },
			},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);
		expect(response.status).toBe(404);
		expect(checked).toBe(false);
	});
});
