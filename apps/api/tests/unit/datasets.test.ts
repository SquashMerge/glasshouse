import { describe, expect, it } from "bun:test";
import {
	addDatasetItem,
	createDataset,
	DatasetRepositoryError,
	deleteDatasetItem,
	getDatasetBySlug,
	getDatasetDraft,
	getOrCreateDatasetDraft,
	getDataset,
	listDatasetItems,
	listDatasets,
	upsertDatasetDraftItem,
	updateDatasetMetadata,
} from "../../src/db/datasets";
import { createDatasetRouteHandlers } from "../../src/routes/datasets";
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
			position: 0,
		});
	});

	it("returns the actual metadata item count", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
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
				query.text.includes("COUNT(*)::int FROM dataset_items"),
			),
		).toBe(true);
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

	it("persists trace and observation provenance when adding an item", async () => {
		const itemId = "33333333-3333-4333-8333-333333333333";
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [datasetRow], rowCount: 1 },
			{
				rows: [
					{
						id: itemId,
						dataset_id: DATASET,
						input: { question: "hello" },
						expected_output: null,
						metadata: {},
						source_trace_id: "a".repeat(32),
						source_observation_id: "b".repeat(16),
						created_at: NOW,
					},
				],
				rowCount: 1,
			},
		]);
		const result = await addDatasetItem(db, {
			project_id: PROJECT,
			dataset_id: DATASET,
			input: { question: "hello" },
			source_trace_id: "a".repeat(32),
			source_observation_id: "b".repeat(16),
			authorization,
		});
		expect(result.source_trace_id).toBe("a".repeat(32));
		expect(result.source_observation_id).toBe("b".repeat(16));
		expect(
			db.queries.some((query) => query.text.includes("source_trace_id")),
		).toBe(true);
		expect(
			db.queries.some((query) => query.values?.includes("a".repeat(32))),
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
			PROJECT,
			DATASET,
			"golden",
			authorization.actor_id,
		]);
	});

	it("deletes a feedback-linked item after severing the readable feedback association", async () => {
		const itemId = "33333333-3333-4333-8333-333333333333";
		const db = fakeDb([{ rows: [] }, { rows: [{ id: PROJECT }] }]);
		const query = db.query;
		const feedback: {
			status: "added_to_dataset" | "reviewed";
			dataset_id: string | null;
			dataset_item_id: string | null;
		} = {
			status: "added_to_dataset",
			dataset_id: DATASET,
			dataset_item_id: itemId,
		};
		db.query = async (text, values) => {
			if (text.startsWith("UPDATE feedback_reviews")) {
				db.queries.push({ text, values });
				feedback.status = "reviewed";
				feedback.dataset_id = null;
				feedback.dataset_item_id = null;
				return { rows: [], rowCount: 1 };
			}
			if (text.startsWith("DELETE FROM dataset_items")) {
				db.queries.push({ text, values });
				if (feedback.dataset_item_id) throw { code: "23503" };
				return { rows: [], rowCount: 1 };
			}
			return query(text, values);
		};

		await expect(
			deleteDatasetItem(db, {
				project_id: PROJECT,
				dataset_id: DATASET,
				item_id: itemId,
				authorization,
			}),
		).resolves.toBeUndefined();
		expect(feedback).toEqual({
			status: "reviewed",
			dataset_id: null,
			dataset_item_id: null,
		});
		const clearLink = db.queries.findIndex((query) =>
			query.text.startsWith("UPDATE feedback_reviews"),
		);
		const removeItem = db.queries.findIndex((query) =>
			query.text.startsWith("DELETE FROM dataset_items"),
		);
		expect(clearLink).toBeGreaterThan(-1);
		expect(db.queries[clearLink]?.values).toEqual([PROJECT, DATASET, itemId]);
		expect(removeItem).toBeGreaterThan(clearLink);
	});

	it("locks and authorizes the active project before every dataset mutation", async () => {
		for (const operation of [createDataset, addDatasetItem, deleteDatasetItem])
			expect(operation.toString()).toContain("lockActiveAuthorizedProject");
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

		expect(response.status).toBe(404);
		expect(added).toBe(false);
		expect(checked).toEqual({
			organization_id: "00000000-0000-4000-8000-000000000001",
			project_id: PROJECT,
			trace_id: "a".repeat(32),
			observation_id: "b".repeat(16),
		});
	});

	it("returns only the documented draft item fields from the route", async () => {
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
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
});
