import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
	addDatasetItem,
	authorizeDatasetWrite,
	captureDatasetDraftItem,
	createDataset,
	DatasetRepositoryError,
	datasetCurationRequestHash,
	deleteDatasetDraftItem,
	deleteDatasetItem,
	discardDatasetDraft,
	exportDataset,
	getDataset,
	getDatasetBySlug,
	getDatasetCurationReplay,
	getDatasetDraft,
	getDatasetDraftItemRevisions,
	getDatasetVersion,
	getOrCreateDatasetDraft,
	importDatasetDraftItems,
	listDatasetItems,
	listDatasets,
	listPublishedDatasetItems,
	listDatasetVersions,
	publishDatasetDraft,
	tombstoneDataset,
	updateDatasetMetadata,
	upsertDatasetDraftItem,
} from "../../src/db/datasets";
import {
	captureDatasetDraftItem as captureDatasetDraftItemRoute,
	createDatasetDraft,
	createDatasetRouteHandlers,
	deleteDatasetDraftItem as deleteDatasetDraftItemRoute,
	exportDataset as exportDatasetRoute,
	deleteDatasetItem as deleteDatasetItemRoute,
	getDatasetDraft as getDatasetDraftRoute,
	handleCreateDatasetDraft,
	handleDeleteDatasetDraftItem,
	handleGetDatasetDraft,
	handleListPublishedDatasetItems,
	handlePutDatasetDraftItem,
	importDatasetDraftItems as importDatasetDraftItemsRoute,
	listPublishedDatasetItems as listPublishedDatasetItemsRoute,
	publishDatasetDraft as publishDatasetDraftRoute,
	putDatasetDraftItem,
	restoreDataset as restoreDatasetRoute,
	tombstoneDataset as tombstoneDatasetRoute,
} from "../../src/routes/datasets";
import {
	DatasetCreate,
	DatasetDraftImport,
	DatasetDraftItem,
	DatasetDraftItemKeyParam,
	DatasetDraftItemParam,
	DatasetDraftItemRevision,
	DatasetDraftItemUpsert,
	DatasetExportQuery,
	DatasetItem,
	DatasetItemCreate,
	DatasetVersion,
} from "../../src/schemas/datasets";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const DATASET = "22222222-2222-4222-8222-222222222222";
const OTHER_DATASET = "33333333-3333-4333-8333-333333333333";
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

function curationReplayDb({
	requestHash,
	recordDatasetId = DATASET,
	draftAvailable = true,
	archived = false,
	replay = true,
}: {
	requestHash: string;
	recordDatasetId?: string | null;
	draftAvailable?: boolean;
	archived?: boolean;
	replay?: boolean;
}) {
	const draftId = "55555555-5555-4555-8555-555555555555";
	const queries: Array<{ text: string; values?: unknown[] }> = [];
	const client = {
		query: async (sql: string, values?: unknown[]) => {
			queries.push({ text: sql, values });
			if (sql.includes("p.status = ANY($3::text[])"))
				return { rows: [{ id: PROJECT }] };
			if (sql.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			if (sql.startsWith("SELECT id FROM datasets WHERE project_id"))
				return {
					rows: [
						{
							id:
								values?.[1] === "golden" || values?.[1] === DATASET
									? DATASET
									: OTHER_DATASET,
							archived_at: archived ? NOW : null,
						},
					],
				};
			if (sql.startsWith("SELECT dr.* FROM dataset_drafts")) {
				if (!draftAvailable) return { rows: [] };
				return {
					rows: [
						{
							id: draftId,
							dataset_id: values?.[1] === "golden" ? DATASET : OTHER_DATASET,
							revision: 4,
						},
					],
				};
			}
			if (sql.startsWith("WITH selected AS"))
				return {
					rows: [
						{
							id: draftId,
							dataset_id: DATASET,
							revision: 4,
							item_count: 0,
							created: false,
						},
					],
				};
			if (sql.includes("FROM dataset_curation_idempotency"))
				return {
					rows: replay
						? [
								{
									dataset_id: recordDatasetId,
									request_hash: requestHash,
									response: {
										draft_id: draftId,
										revision: 7,
										item_ids: ["item"],
									},
								},
							]
						: [],
				};
			return { rows: [] };
		},
		release() {},
	};
	return { connect: async () => client, queries };
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
			validation_version: 1,
			state: "reviewed",
			external_id: null,
			source_trace_id: null,
			source_observation_id: null,
			source_feedback_id: null,
			capture_context: {},
			created_by: null,
			updated_by: null,
			reviewed_by: null,
			reviewed_at: null,
			created_at: NOW.toISOString(),
		});
		expect(result.success).toBe(true);
	});

	it("accepts a stable dataset slug, draft item key, and UUID item identity", () => {
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
				itemId: "33333333-3333-4333-8333-333333333333",
			}).success,
		).toBe(true);
		expect(
			DatasetDraftItemUpsert.safeParse({
				input: { question: "hello" },
				metadata: { source: "test" },
			}).success,
		).toBe(true);
	});

	it("rejects empty draft provenance identifiers", () => {
		expect(
			DatasetDraftItemUpsert.safeParse({
				input: { question: "hello" },
				source_trace_id: "",
			}).success,
		).toBe(false);
		expect(
			DatasetDraftItemUpsert.safeParse({
				input: { question: "hello" },
				source_trace_id: "a".repeat(32),
				source_observation_id: "",
			}).success,
		).toBe(false);
	});

	it("defers duplicate import keys to the atomic per-row repository validation", () => {
		expect(
			DatasetDraftImport.safeParse({
				items: [
					{ item_key: "same", input: { question: "first" } },
					{ item_key: "same", input: { question: "second" } },
				],
			}).success,
		).toBe(true);
	});

	it("normalizes direct upsert item keys like imports and rejects blank keys", () => {
		const direct = DatasetDraftItemKeyParam.safeParse({
			slug: "golden-suite",
			itemKey: "  stable  ",
		});
		const imported = DatasetDraftImport.safeParse({
			items: [{ item_key: "  stable  ", input: { question: "hello" } }],
		});

		expect(direct).toMatchObject({
			success: true,
			data: { slug: "golden-suite", itemKey: "stable" },
		});
		expect(imported).toMatchObject({
			success: true,
			data: { items: [{ item_key: "stable" }] },
		});
		expect(
			DatasetDraftItemKeyParam.safeParse({
				slug: "golden-suite",
				itemKey: " \t ",
			}).success,
		).toBe(false);
		expect(
			DatasetDraftImport.safeParse({
				items: [{ item_key: " \t ", input: { question: "hello" } }],
			}).success,
		).toBe(false);
	});
});

describe("dataset repository", () => {
	it("replays import after its draft is published", async () => {
		const item = {
			project_id: PROJECT,
			item_key: "imported",
			input: { question: "hello" },
		};
		const db = curationReplayDb({
			requestHash: datasetCurationRequestHash({
				dataset_id: DATASET,
				revision: 4,
				items: [item],
			}),
			draftAvailable: false,
		});

		await expect(
			importDatasetDraftItems(db, {
				project_id: PROJECT,
				slug: "golden",
				revision: 4,
				items: [item],
				idempotency_key: "published-import-key",
				authorization,
			}),
		).resolves.toMatchObject({ revision: 7, idempotent: true });
		expect(
			db.queries.some((query) =>
				query.text.startsWith("SELECT dr.* FROM dataset_drafts"),
			),
		).toBe(false);
	});

	it("replays capture after its draft is discarded", async () => {
		const request = {
			dataset_id: DATASET,
			revision: 4,
			item_key: "captured",
			external_id: null,
			source_trace_id: null,
			source_observation_id: null,
		};
		const db = curationReplayDb({
			requestHash: datasetCurationRequestHash(request),
			draftAvailable: false,
		});

		await expect(
			captureDatasetDraftItem(db, {
				project_id: PROJECT,
				slug: "golden",
				revision: 4,
				item_key: "captured",
				input: { question: "hello" },
				metadata: {},
				idempotency_key: "discarded-capture-key",
				authorization,
			}),
		).resolves.toMatchObject({ revision: 7, idempotent: true });
		expect(
			db.queries.some((query) =>
				query.text.startsWith("SELECT dr.* FROM dataset_drafts"),
			),
		).toBe(false);
	});

	it("replays capture after its dataset is archived", async () => {
		const request = {
			dataset_id: DATASET,
			revision: 4,
			item_key: "captured",
			external_id: null,
			source_trace_id: null,
			source_observation_id: null,
		};
		const db = curationReplayDb({
			requestHash: datasetCurationRequestHash(request),
			draftAvailable: false,
			archived: true,
		});

		await expect(
			captureDatasetDraftItem(db, {
				project_id: PROJECT,
				slug: "golden",
				revision: 4,
				item_key: "captured",
				input: { question: "hello" },
				metadata: {},
				idempotency_key: "archived-capture-key",
				authorization,
			}),
		).resolves.toMatchObject({ revision: 7, idempotent: true });
		const targetLookup = db.queries.find((query) =>
			query.text.startsWith("SELECT id FROM datasets WHERE project_id"),
		);
		expect(targetLookup?.text).not.toContain("archived_at IS NULL");
	});

	it("replays a curation request with its original draft revision", async () => {
		const request = {
			revision: 4,
			item_key: "captured",
			external_id: null,
			source_trace_id: "a".repeat(32),
			source_observation_id: null,
		};
		const db = curationReplayDb({
			requestHash: datasetCurationRequestHash({
				...request,
				dataset_id: DATASET,
			}),
		});

		await expect(
			getDatasetCurationReplay(db, {
				project_id: PROJECT,
				slug: "golden",
				operation: "capture",
				idempotency_key: "response-loss-capture-key",
				idempotency_request: request,
				authorization,
			}),
		).resolves.toMatchObject({ revision: 7, item_ids: ["item"] });
	});

	it("replays a target-bound legacy import record after upgrade", async () => {
		const item = {
			project_id: PROJECT,
			item_key: "imported",
			input: { question: "hello" },
		};
		const legacyRequestHash = datasetCurationRequestHash({
			revision: 4,
			items: [item],
		});
		const requestHash = datasetCurationRequestHash({
			dataset_id: DATASET,
			revision: 4,
			items: [item],
		});
		const db = curationReplayDb({
			requestHash: legacyRequestHash,
			draftAvailable: false,
		});

		await expect(
			importDatasetDraftItems(db, {
				project_id: PROJECT,
				slug: "golden",
				revision: 4,
				items: [item],
				idempotency_key: "legacy-import-key",
				authorization,
			}),
		).resolves.toMatchObject({ revision: 7, idempotent: true });
		expect(
			db.queries.find((query) =>
				query.text.startsWith(
					"UPDATE dataset_curation_idempotency SET request_hash",
				),
			)?.values,
		).toEqual([
			requestHash,
			PROJECT,
			authorization.actor_id,
			"import",
			"legacy-import-key",
		]);
	});

	it("rejects legacy import reuse for another dataset target", async () => {
		const item = {
			project_id: PROJECT,
			item_key: "imported",
			input: { question: "hello" },
		};
		const db = curationReplayDb({
			requestHash: datasetCurationRequestHash({
				revision: 4,
				items: [item],
			}),
			recordDatasetId: OTHER_DATASET,
			draftAvailable: false,
		});

		await expect(
			importDatasetDraftItems(db, {
				project_id: PROJECT,
				slug: "golden",
				revision: 4,
				items: [item],
				idempotency_key: "legacy-other-target-key",
				authorization,
			}),
		).rejects.toMatchObject<DatasetRepositoryError>({
			code: "CONFLICT",
			status: 409,
		});
	});

	it("preserves import replay while rejecting the same key for another dataset", async () => {
		const item = {
			project_id: PROJECT,
			item_key: "imported",
			input: { question: "hello" },
		};
		const requestHash = datasetCurationRequestHash({
			dataset_id: DATASET,
			revision: 4,
			items: [item],
		});
		const db = curationReplayDb({ requestHash });
		const input = {
			project_id: PROJECT,
			revision: 4,
			items: [item],
			idempotency_key: "shared-import-key",
			authorization,
		};

		await expect(
			importDatasetDraftItems(db, { ...input, slug: "golden" }),
		).resolves.toMatchObject({ revision: 7, idempotent: true });
		await expect(
			importDatasetDraftItems(db, { ...input, slug: "other" }),
		).rejects.toMatchObject<DatasetRepositoryError>({
			code: "CONFLICT",
			status: 409,
		});
	});

	it("preserves capture replay while rejecting the same key for another dataset", async () => {
		const request = {
			dataset_id: DATASET,
			revision: 4,
			item_key: "captured",
			external_id: null,
			source_trace_id: null,
			source_observation_id: null,
		};
		const db = curationReplayDb({
			requestHash: datasetCurationRequestHash(request),
		});
		const input = {
			project_id: PROJECT,
			revision: 4,
			item_key: "captured",
			input: { question: "hello" },
			metadata: {},
			idempotency_key: "shared-capture-key",
			authorization,
		};

		await expect(
			captureDatasetDraftItem(db, { ...input, slug: "golden" }),
		).resolves.toMatchObject({ revision: 7, idempotent: true });
		await expect(
			captureDatasetDraftItem(db, { ...input, slug: "other" }),
		).rejects.toMatchObject<DatasetRepositoryError>({
			code: "CONFLICT",
			status: 409,
		});
	});

	it("rejects duplicate import keys before writing any draft item", async () => {
		const db = curationReplayDb({ requestHash: "", replay: false });
		await expect(
			importDatasetDraftItems(db, {
				project_id: PROJECT,
				slug: "golden",
				revision: 4,
				items: [
					{
						project_id: PROJECT,
						item_key: "same",
						input: { question: "first" },
					},
					{
						project_id: PROJECT,
						item_key: "same",
						input: { question: "second" },
					},
				],
				idempotency_key: "duplicate-import-key",
				authorization,
			}),
		).rejects.toMatchObject<DatasetRepositoryError>({
			code: "BAD_REQUEST",
			status: 400,
		});
		expect(
			db.queries.some((query) =>
				query.text.includes("ON CONFLICT (draft_id, item_key) DO UPDATE"),
			),
		).toBe(false);
		expect(
			db.queries.some((query) => query.text.startsWith("WITH selected AS")),
		).toBe(false);
	});

	it("atomically rejects import keys that already exist in the shared draft", async () => {
		const queries: string[] = [];
		const client = {
			query: async (sql: string) => {
				queries.push(sql);
				if (sql.includes("p.status = ANY($3::text[])"))
					return { rows: [{ id: PROJECT }] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.startsWith("SELECT id FROM datasets WHERE project_id"))
					return { rows: [{ id: DATASET }] };
				if (sql.startsWith("SELECT dr.* FROM dataset_drafts"))
					return {
						rows: [
							{
								id: "55555555-5555-4555-8555-555555555555",
								dataset_id: DATASET,
								revision: 4,
							},
						],
					};
				if (sql.startsWith("SELECT item_key FROM dataset_draft_items"))
					return { rows: [{ item_key: "existing" }] };
				return { rows: [] };
			},
			release() {},
		};

		await expect(
			importDatasetDraftItems({ connect: async () => client } as never, {
				project_id: PROJECT,
				slug: "golden",
				revision: 4,
				items: [
					{
						project_id: PROJECT,
						item_key: "existing",
						input: { question: "must not overwrite" },
					},
				],
				idempotency_key: "existing-import-key",
				authorization,
			}),
		).rejects.toMatchObject<DatasetRepositoryError>({
			code: "BAD_REQUEST",
			details: {
				errors: [
					expect.objectContaining({
						item_key: "existing",
						field: "items/0/item_key",
						code: "DUPLICATE_ITEM_KEY",
					}),
				],
			},
		});
		expect(
			queries.some((query) =>
				query.includes("ON CONFLICT (draft_id, item_key) DO UPDATE"),
			),
		).toBe(false);
	});

	it("validates an import before creating a missing draft", async () => {
		const db = curationReplayDb({ requestHash: "", replay: false });
		await expect(
			importDatasetDraftItems(db, {
				project_id: PROJECT,
				slug: "golden",
				items: [
					{
						project_id: PROJECT,
						item_key: "too-large",
						input: { question: "x".repeat(16_385) },
					},
				],
				idempotency_key: "invalid-import-key",
				authorization,
			}),
		).rejects.toMatchObject<DatasetRepositoryError>({
			code: "BAD_REQUEST",
			status: 400,
		});
		expect(
			db.queries.some((query) => query.text.startsWith("WITH selected AS")),
		).toBe(false);
		expect(
			db.queries.some((query) =>
				query.text.includes("INSERT INTO dataset_draft_items"),
			),
		).toBe(false);
	});

	it("requires a revision before importing into an existing shared draft", async () => {
		const db = curationReplayDb({ requestHash: "", replay: false });
		await expect(
			importDatasetDraftItems(db, {
				project_id: PROJECT,
				slug: "golden",
				items: [
					{
						project_id: PROJECT,
						item_key: "new-item",
						input: { question: "hello" },
					},
				],
				idempotency_key: "missing-revision-key",
				authorization,
			}),
		).rejects.toMatchObject<DatasetRepositoryError>({
			code: "CONFLICT",
			status: 409,
			details: {
				current_revision: 4,
				field_diff: [
					expect.objectContaining({
						field: "revision",
						current: 4,
						requested: null,
					}),
				],
			},
		});
		expect(
			db.queries.some((query) =>
				query.text.includes("ON CONFLICT (draft_id, item_key) DO UPDATE"),
			),
		).toBe(false);
	});

	it("derives a stable capture item key for retries without a caller item key", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			authorizeDatasetWrite: async () => {},
			getDatasetCurationReplay: async () => null,
			captureSource: async () => ({
				input_text: "question",
				output_text: null,
			}),
			captureDatasetDraftItem: async (
				_db: unknown,
				input: Record<string, unknown>,
			) => {
				captured.push(input);
				return { item: null, revision: 2, idempotent: true };
			},
		} as never);
		const request = {
			get: () => ({
				actor: "test",
				actorId: authorization.actor_id,
				organizationId: authorization.organization_id,
			}),
			req: {
				header: () => '"1"',
				valid: (part: string) =>
					part === "param"
						? { slug: "golden" }
						: part === "query"
							? { project_id: PROJECT }
							: part === "header"
								? { "idempotency-key": "capture-retry-key" }
								: { source_trace_id: "a".repeat(32) },
			},
			header() {},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		};

		await handlers.handleCaptureDatasetDraftItem(request as never);
		await handlers.handleCaptureDatasetDraftItem(request as never);
		expect(captured).toHaveLength(2);
		expect(captured[0]?.item_key).toBe(captured[1]?.item_key);
		expect(captured[0]?.item_key).toMatch(/^capture-[0-9a-f]{32}$/);
	});

	it("does not create a draft or item when a capture source is missing", async () => {
		let captured = false;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			authorizeDatasetWrite: async () => {},
			getDatasetCurationReplay: async () => null,
			captureSource: async () => null,
			captureDatasetDraftItem: async () => {
				captured = true;
				return { item: null, revision: 1, idempotent: false };
			},
		} as never);
		const response = await handlers.handleCaptureDatasetDraftItem({
			get: () => ({
				actor: "test",
				actorId: authorization.actor_id,
				organizationId: authorization.organization_id,
			}),
			req: {
				header: () => undefined,
				valid: (part: string) =>
					part === "param"
						? { slug: "golden" }
						: part === "query"
							? { project_id: PROJECT }
							: part === "header"
								? { "idempotency-key": "missing-source-key" }
								: { source_trace_id: "a".repeat(32) },
			},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);

		expect(response.status).toBe(404);
		expect(captured).toBe(false);
	});

	it("replays capture before reading a retained source again", async () => {
		let sourceRead = false;
		let captured = false;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			getDatasetCurationReplay: async () => ({
				draft_id: "55555555-5555-4555-8555-555555555555",
				revision: 7,
				item_ids: ["66666666-6666-4666-8666-666666666666"],
			}),
			captureSource: async () => {
				sourceRead = true;
				return null;
			},
			captureDatasetDraftItem: async () => {
				captured = true;
				return {} as never;
			},
		} as never);
		const response = await handlers.handleCaptureDatasetDraftItem({
			get: () => ({
				actor: "test",
				actorId: authorization.actor_id,
				organizationId: authorization.organization_id,
			}),
			req: {
				header: () => '"4"',
				valid: (part: string) =>
					part === "param"
						? { slug: "golden" }
						: part === "query"
							? { project_id: PROJECT }
							: part === "header"
								? { "idempotency-key": "response-loss-capture-key" }
								: { source_trace_id: "a".repeat(32) },
			},
			header() {},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			revision: 7,
			idempotent: true,
		});
		expect(sourceRead).toBe(false);
		expect(captured).toBe(false);
	});

	it("replays import before rereading retained source rows", async () => {
		let sourceRead = false;
		let imported = false;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			getDatasetCurationReplay: async () => ({
				draft_id: "55555555-5555-4555-8555-555555555555",
				revision: 7,
				item_ids: ["66666666-6666-4666-8666-666666666666"],
			}),
			captureSource: async () => {
				sourceRead = true;
				return null;
			},
			importDatasetDraftItems: async () => {
				imported = true;
				return {} as never;
			},
		} as never);
		const response = await handlers.handleImportDatasetDraftItems({
			get: () => ({
				actor: "test",
				actorId: authorization.actor_id,
				organizationId: authorization.organization_id,
			}),
			req: {
				header: () => '"4"',
				valid: (part: string) =>
					part === "param"
						? { slug: "golden" }
						: part === "query"
							? { project_id: PROJECT }
							: part === "header"
								? { "idempotency-key": "response-loss-import-key" }
								: {
										items: [
											{
												item_key: "captured",
												input: { question: "caller value" },
												source_trace_id: "a".repeat(32),
											},
										],
									},
			},
			header() {},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			revision: 7,
			idempotent: true,
			items: [],
		});
		expect(sourceRead).toBe(false);
		expect(imported).toBe(false);
	});

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

	it("returns the ordered immutable snapshot instead of the mutable draft", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{
				rows: [
					{
						id: "55555555-5555-4555-8555-555555555555",
						dataset_id: DATASET,
						project_id: PROJECT,
						version: 1,
						item_count: 2,
						content_hash: "a".repeat(64),
						validation_version: 1,
						published_by: authorization.actor_id,
						published_draft_revision: 4,
						created_at: NOW,
					},
				],
			},
			{
				rows: [
					{
						id: "66666666-6666-4666-8666-666666666666",
						item_key: "first",
						position: 0,
						validation_version: 1,
						state: "reviewed",
						input: { question: "published first" },
						expected_output: { answer: "first" },
						metadata: { source: "snapshot" },
						external_id: "source-1",
						source_trace_id: "trace-1",
						source_observation_id: "observation-1",
						feedback_score_id: "88888888-8888-4888-8888-888888888888",
						capture_context: { redaction_applied: true },
						curated_by: "99999999-9999-4999-8999-999999999999",
						reviewed_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
						reviewed_at: NOW,
						comment: "raw feedback must not be returned",
						created_at: NOW,
					},
					{
						id: "77777777-7777-4777-8777-777777777777",
						item_key: "second",
						position: 1,
						validation_version: 1,
						state: "reviewed",
						input: { question: "published second" },
						expected_output: null,
						metadata: {},
						external_id: null,
						source_trace_id: null,
						source_observation_id: null,
						capture_context: {},
						created_at: NOW,
					},
				],
			},
		]);

		const result = await getDatasetVersion(db, {
			project_id: PROJECT,
			slug: "golden",
			version: 1,
			authorization: { ...authorization, operation: "product_read" },
		});

		expect(DatasetVersion.safeParse(result).success).toBe(true);
		expect(result.items.map((item) => item.item_key)).toEqual([
			"first",
			"second",
		]);
		expect(result.items[0]).toMatchObject({
			input: { question: "published first" },
			source_trace_id: "trace-1",
			source_observation_id: "observation-1",
			feedback_score_id: "88888888-8888-4888-8888-888888888888",
			capture_context: { redaction_applied: true },
			curated_by: "99999999-9999-4999-8999-999999999999",
			reviewed_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			reviewed_at: NOW.toISOString(),
		});
		expect(result.items[0]).not.toHaveProperty("comment");
		expect(
			db.queries.some((query) => query.text.includes("dataset_draft_items")),
		).toBe(false);
		expect(
			db.queries.some(
				(query) =>
					query.text.includes("dataset_version_items") &&
					query.text.includes("project_id = $1") &&
					query.text.includes("feedback_score_id") &&
					query.text.includes("curated_by") &&
					query.text.includes("reviewed_by") &&
					query.text.includes("reviewed_at"),
			),
		).toBe(true);
	});

	it("does not disclose absent or cross-project dataset slugs through an empty version list", async () => {
		for (const slug of ["missing", "other-project-dataset"]) {
			const db = fakeDb([
				{ rows: [] },
				{ rows: [{ id: PROJECT }] },
				{ rows: [] },
			]);
			await expect(
				listDatasetVersions(db, {
					project_id: PROJECT,
					slug,
					authorization: { ...authorization, operation: "product_read" },
				}),
			).rejects.toMatchObject<DatasetRepositoryError>({
				code: "NOT_FOUND",
				status: 404,
			});
		}
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
		expect(query?.text).toContain("i.item_key");
		expect(query?.text).not.toContain("NULL::text AS item_key");
	});

	it("exposes published items through a dedicated immutable read route", async () => {
		let received: Record<string, unknown> | undefined;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			listPublishedDatasetItems: async (
				_db: unknown,
				input: Record<string, unknown>,
			) => {
				received = input;
				return { items: [] };
			},
		} as never);
		const response = await handlers.handleListPublishedDatasetItems({
			get: () => ({
				actor: "test",
				actorId: authorization.actor_id,
				organizationId: authorization.organization_id,
			}),
			req: {
				valid: (part: string) =>
					part === "param" ? { id: DATASET } : { project_id: PROJECT },
			},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);

		expect(await response.json()).toEqual({ items: [] });
		expect(received).toMatchObject({
			dataset_id: DATASET,
			project_id: PROJECT,
			authorization: { operation: "product_read" },
		});
		const app = new OpenAPIHono();
		app.openapi(
			listPublishedDatasetItemsRoute,
			handleListPublishedDatasetItems,
		);
		expect(
			app.getOpenAPIDocument({
				openapi: "3.1.0",
				info: { title: "test", version: "1" },
			}).paths?.["/v1/datasets/{id}/published-items"]?.get,
		).toBeDefined();
	});

	it("serializes draft items to the exact public schema without persisted fields", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [{ id: "draft", dataset_id: DATASET, revision: 1 }] },
			{
				rows: [
					{
						id: "33333333-3333-4333-8333-333333333333",
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
		expect(result).toMatchObject({
			id: "33333333-3333-4333-8333-333333333333",
			item_key: "stable",
			input: { question: "hello" },
			expected_output: null,
			metadata: { source: "test" },
			source_trace_id: "trace",
			source_observation_id: null,
			position: 0,
			validation_version: 1,
			state: "reviewed",
			capture_context: {},
		});
		const revision = db.queries.find((query) =>
			query.text.startsWith("INSERT INTO dataset_draft_item_revisions"),
		);
		expect(revision?.text).toContain("dataset_id");
		expect(revision?.values?.slice(0, 3)).toEqual([
			PROJECT,
			DATASET,
			"33333333-3333-4333-8333-333333333333",
		]);
	});

	it("returns draft-item revision history with the stable item ID and action actor", async () => {
		const draftItemId = "33333333-3333-4333-8333-333333333333";
		const revisionId = "44444444-4444-4444-8444-444444444444";
		const actorId = "55555555-5555-4555-8555-555555555555";
		const queries: string[] = [];
		const client = {
			query: async (sql: string) => {
				queries.push(sql);
				if (sql.includes("p.status = ANY($3::text[])"))
					return { rows: [{ id: PROJECT }] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.startsWith("SELECT revision.*"))
					return {
						rows: [
							{
								id: revisionId,
								draft_item_id: draftItemId,
								item_id: draftItemId,
								item_revision: 3,
								item_key: "stable",
								position: 0,
								validation_version: 1,
								state: "reviewed",
								input: { question: "hello" },
								expected_output: null,
								metadata: {},
								external_id: null,
								source_trace_id: null,
								source_observation_id: null,
								feedback_score_id: null,
								capture_context: {},
								action: "reviewed",
								actor_id: actorId,
								created_at: NOW,
							},
						],
					};
				return { rows: [] };
			},
			release() {},
		};

		const result = await getDatasetDraftItemRevisions(
			{ connect: async () => client } as never,
			{
				project_id: PROJECT,
				slug: "golden",
				item_id: draftItemId,
				authorization: { ...authorization, operation: "product_read" },
			},
		);

		expect(result.items[0]).toMatchObject({
			id: draftItemId,
			item_revision: 3,
			action: "reviewed",
			actor_id: actorId,
		});
		expect(result.items[0]?.id).not.toBe(revisionId);
		expect(DatasetDraftItemRevision.safeParse(result.items[0]).success).toBe(
			true,
		);
		expect(
			queries.some((sql) => sql.includes("dataset_lifecycle_audit_events")),
		).toBe(false);
	});

	it("returns revision history for the immutable published item UUID", async () => {
		const draftItemId = "33333333-3333-4333-8333-333333333333";
		const publishedItemId = "66666666-6666-4666-8666-666666666666";
		const actorId = "55555555-5555-4555-8555-555555555555";
		const queries: string[] = [];
		const client = {
			query: async (sql: string, values?: unknown[]) => {
				queries.push(sql);
				if (sql.includes("p.status = ANY($3::text[])"))
					return { rows: [{ id: PROJECT }] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.startsWith("SELECT revision.*")) {
					expect(values).toEqual([PROJECT, "golden", publishedItemId]);
					return {
						rows: [
							{
								id: "44444444-4444-4444-8444-444444444444",
								draft_item_id: draftItemId,
								dataset_version_item_id: publishedItemId,
								item_id: publishedItemId,
								item_revision: 3,
								item_key: "stable",
								position: 0,
								validation_version: 1,
								state: "reviewed",
								input: { question: "hello" },
								expected_output: null,
								metadata: {},
								external_id: null,
								source_trace_id: null,
								source_observation_id: null,
								feedback_score_id: null,
								capture_context: {},
								action: "reviewed",
								actor_id: actorId,
								created_at: NOW,
							},
						],
					};
				}
				return { rows: [] };
			},
			release() {},
		};

		const result = await getDatasetDraftItemRevisions(
			{ connect: async () => client } as never,
			{
				project_id: PROJECT,
				slug: "golden",
				item_id: publishedItemId,
				authorization: { ...authorization, operation: "product_read" },
			},
		);

		expect(result.items[0]).toMatchObject({
			id: publishedItemId,
			item_revision: 3,
			action: "reviewed",
			actor_id: actorId,
		});
		const historyQuery = queries.find((sql) =>
			sql.startsWith("SELECT revision.*"),
		);
		expect(historyQuery).toContain("dataset_version_item_id");
		expect(historyQuery).not.toContain("JOIN dataset_draft_items");
		expect(
			queries.some((sql) => sql.includes("dataset_lifecycle_audit_events")),
		).toBe(false);
	});

	it("returns retained history after its draft is discarded", async () => {
		const draftItemId = "33333333-3333-4333-8333-333333333333";
		const actorId = "55555555-5555-4555-8555-555555555555";
		const queries: string[] = [];
		const client = {
			query: async (sql: string) => {
				queries.push(sql);
				if (sql.includes("p.status = ANY($3::text[])"))
					return { rows: [{ id: PROJECT }] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.startsWith("SELECT revision.*"))
					return {
						rows: [
							{
								id: "44444444-4444-4444-8444-444444444444",
								draft_item_id: draftItemId,
								item_id: draftItemId,
								item_revision: 1,
								item_key: "discarded",
								position: 0,
								validation_version: 1,
								state: "draft",
								input: { question: "hello" },
								expected_output: null,
								metadata: {},
								external_id: null,
								source_trace_id: null,
								source_observation_id: null,
								feedback_score_id: null,
								capture_context: {},
								action: "upserted",
								actor_id: actorId,
								created_at: NOW,
							},
						],
					};
				return { rows: [] };
			},
			release() {},
		};

		const result = await getDatasetDraftItemRevisions(
			{ connect: async () => client } as never,
			{
				project_id: PROJECT,
				slug: "golden",
				item_id: draftItemId,
				authorization: { ...authorization, operation: "product_read" },
			},
		);

		expect(result.items[0]).toMatchObject({
			id: draftItemId,
			action: "upserted",
			actor_id: actorId,
		});
		const historyQuery = queries.find((sql) =>
			sql.startsWith("SELECT revision.*"),
		);
		expect(historyQuery).not.toContain("JOIN dataset_drafts");
		expect(
			queries.some((sql) => sql.includes("dataset_lifecycle_audit_events")),
		).toBe(false);
	});

	it("serves draft-item revision history with product-read authorization", async () => {
		let received: Record<string, unknown> | undefined;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			getDatasetDraftItemRevisions: async (_db, input) => {
				received = input;
				return { items: [] };
			},
		} as never);
		const response = await handlers.handleListDatasetDraftItemRevisions({
			get: () => ({
				actor: "test",
				actorId: authorization.actor_id,
				organizationId: authorization.organization_id,
			}),
			req: {
				valid: (part: string) =>
					part === "param"
						? {
								slug: "golden",
								itemId: "33333333-3333-4333-8333-333333333333",
							}
						: { project_id: PROJECT },
			},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);

		expect(response.status).toBe(200);
		expect(received).toMatchObject({
			project_id: PROJECT,
			authorization: { operation: "product_read" },
		});
	});

	it("returns the actual metadata item count", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [] },
			{ rows: [datasetRow] },
			{ rows: [{ ...datasetRow, item_count: 3, lifecycle_revision: 2 }] },
		]);
		await expect(
			updateDatasetMetadata(db, {
				project_id: PROJECT,
				slug: "golden",
				name: "Golden updated",
				revision: 1,
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
		const draftQuery = db.queries.find((query) =>
			query.text.startsWith("WITH selected"),
		);
		expect(draftQuery?.text).toContain("RETURNING draft_id");
		expect(draftQuery?.text).toContain("FROM copied c WHERE c.draft_id = d.id");
		expect(draftQuery?.text).toContain(
			"FROM dataset_draft_items i WHERE i.draft_id = d.id",
		);
		expect(draftQuery?.text).not.toContain("GROUP BY d.id");
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
			{ rows: [] },
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

	it("does not delete a draft item that is durable promoted-feedback evidence", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [{ id: "draft", dataset_id: DATASET, revision: 2 }] },
			{ rows: [{ score_id: "feedback" }] },
		]);
		await expect(
			deleteDatasetDraftItem(db, {
				project_id: PROJECT,
				slug: "golden",
				item_key: "33333333-3333-4333-8333-333333333333",
				revision: 2,
				authorization,
			}),
		).rejects.toMatchObject<DatasetRepositoryError>({ code: "CONFLICT" });
		expect(
			db.queries.some((query) =>
				query.text.startsWith("DELETE FROM dataset_draft_items"),
			),
		).toBe(false);
	});

	it("returns promoted feedback to reviewed before discarding its draft", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [] },
			{ rows: [{ dataset_id: DATASET, revision: 2 }], rowCount: 1 },
		]);
		await discardDatasetDraft(db, {
			project_id: PROJECT,
			slug: "golden",
			authorization,
		});
		const reset = db.queries.find((query) =>
			query.text.startsWith(
				"UPDATE feedback_reviews review SET status = 'reviewed'",
			),
		);
		expect(reset?.values).toEqual([PROJECT, "golden"]);
		expect(
			db.queries.some((query) =>
				query.text.includes("DELETE FROM dataset_draft_item_revisions"),
			),
		).toBe(false);
	});

	it("publishes the complete draft as a new immutable snapshot and consumes it", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{
				rows: [
					{
						id: "draft",
						dataset_id: DATASET,
						revision: 2,
						latest_published_version: 1,
						schema: {},
					},
				],
			},
			{ rows: [] },
			{ rows: [{ version_id: "version", item_count: 2 }] },
			{ rows: [] },
			{ rows: [] },
		]);
		await expect(
			publishDatasetDraft(db, {
				project_id: PROJECT,
				slug: "golden",
				revision: 2,
				authorization,
			}),
		).resolves.toEqual({ version: 2, item_count: 2 });
		const snapshot = db.queries.find((query) =>
			query.text.includes("INSERT INTO dataset_versions"),
		);
		expect(snapshot?.text).toContain(
			"FROM dataset_draft_items WHERE draft_id = $5",
		);
		expect(snapshot?.text).toContain("INSERT INTO dataset_version_items");
		expect(snapshot?.text).toContain(
			"UPDATE dataset_draft_item_revisions revision SET dataset_version_item_id = copied.id",
		);
		expect(
			db.queries.some((query) =>
				query.text.includes(
					"UPDATE feedback_reviews r SET dataset_draft_item_id",
				),
			),
		).toBe(true);
		expect(
			db.queries.some(
				(query) => query.text === "DELETE FROM dataset_drafts WHERE id = $1",
			),
		).toBe(true);
		expect(
			db.queries.some((query) => query.text.includes("'draft_published'")),
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

	it("documents draft ETags and required or creation-only If-Match revisions", () => {
		const app = new OpenAPIHono();
		app.openapi(createDatasetDraft, handleCreateDatasetDraft);
		app.openapi(getDatasetDraftRoute, handleGetDatasetDraft);
		app.openapi(putDatasetDraftItem, handlePutDatasetDraftItem);
		app.openapi(deleteDatasetDraftItemRoute, handleDeleteDatasetDraftItem);
		app.openapi(publishDatasetDraftRoute, async () => new Response());
		app.openapi(importDatasetDraftItemsRoute, async () => new Response());
		app.openapi(captureDatasetDraftItemRoute, async () => new Response());
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
			"/v1/datasets/by-slug/{slug}/draft/items/{itemId}"
		]?.delete as any;
		const imported = document.paths?.[
			"/v1/datasets/by-slug/{slug}/draft/import"
		]?.post as any;
		const captured = document.paths?.[
			"/v1/datasets/by-slug/{slug}/draft/capture"
		]?.post as any;
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
		for (const operation of [imported, captured])
			expect(operation.parameters).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						in: "header",
						name: "if-match",
						required: false,
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
		const publish = app.getOpenAPIDocument({
			openapi: "3.1.0",
			info: { title: "test", version: "1" },
		}).paths?.["/v1/datasets/by-slug/{slug}/draft/publish"]?.post as any;
		expect(publish.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					in: "header",
					name: "if-match",
					required: true,
				}),
			]),
		);
	});

	it("returns only the documented draft item fields from the route", async () => {
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			authorizeDatasetWrite: async () => {},
			upsertDatasetDraftItem: async () => ({
				id: "33333333-3333-4333-8333-333333333333",
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
			id: "33333333-3333-4333-8333-333333333333",
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
			captureSource: async () => null,
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

	it("replaces manual provenance payloads with a server capture", async () => {
		let written: unknown;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			authorizeDatasetWrite: async () => {},
			captureSource: async () => ({
				input_text: '{"question":"server value"}',
				output_text: '{"answer":"server value"}',
			}),
			upsertDatasetDraftItem: async (_db, input) => {
				written = input;
				return {
					id: "33333333-3333-4333-8333-333333333333",
					item_key: "stable",
					input: {},
					expected_output: null,
					metadata: {},
					position: 0,
				};
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
							: {
									input: { question: "caller value" },
									expected_output: { answer: "caller value" },
									source_trace_id: "a".repeat(32),
								},
			},
			header() {},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);

		expect(response.status).toBe(200);
		expect(written).toMatchObject({
			input: { question: "server value" },
			expected_output: { answer: "server value" },
			capture: true,
			capture_context: { kind: "trace" },
		});
	});

	it("imports provenance only from a scoped server capture", async () => {
		let imported: unknown;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			authorizeDatasetWrite: async () => {},
			getDatasetCurationReplay: async () => null,
			captureSource: async (input) => {
				expect(input).toEqual({
					organization_id: authorization.organization_id,
					project_id: PROJECT,
					trace_id: "a".repeat(32),
					observation_id: "observation-1",
				});
				return {
					input_text: '{"question":"server value"}',
					output_text: '{"answer":"redact me"}',
				};
			},
			importDatasetDraftItems: async (_db, input) => {
				imported = input;
				return { items: [], revision: 2, idempotent: false };
			},
		} as never);
		const response = await handlers.handleImportDatasetDraftItems({
			get: () => ({
				actor: "test",
				organizationId: authorization.organization_id,
				actorId: authorization.actor_id,
			}),
			req: {
				header: () => undefined,
				valid: (part: string) =>
					part === "param"
						? { slug: "golden" }
						: part === "query"
							? { project_id: PROJECT }
							: part === "header"
								? { "idempotency-key": "import-key" }
								: {
										items: [
											{
												item_key: "captured",
												input: { question: "caller value" },
												expected_output: { answer: "caller value" },
												source_trace_id: "a".repeat(32),
												source_observation_id: "observation-1",
											},
										],
									},
			},
			header() {},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);

		expect(response.status).toBe(200);
		expect(imported).toMatchObject({
			items: [
				{
					input: { question: "server value" },
					expected_output: { answer: "redact me" },
					capture: true,
					capture_context: { kind: "observation" },
				},
			],
			idempotency_items: [
				{
					input: { question: "caller value" },
					expected_output: { answer: "caller value" },
				},
			],
		});
	});

	it("rejects missing import provenance before writing", async () => {
		let imported = false;
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			authorizeDatasetWrite: async () => {},
			getDatasetCurationReplay: async () => null,
			captureSource: async () => null,
			importDatasetDraftItems: async () => {
				imported = true;
				return {} as never;
			},
		} as never);
		const response = await handlers.handleImportDatasetDraftItems({
			get: () => ({
				actor: "test",
				organizationId: authorization.organization_id,
				actorId: authorization.actor_id,
			}),
			req: {
				header: () => undefined,
				valid: (part: string) =>
					part === "param"
						? { slug: "golden" }
						: part === "query"
							? { project_id: PROJECT }
							: part === "header"
								? { "idempotency-key": "import-key" }
								: {
										items: [
											{
												item_key: "missing",
												input: {},
												source_trace_id: "a".repeat(32),
											},
										],
									},
			},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);
		expect(response.status).toBe(404);
		expect(imported).toBe(false);
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
			captureSource: async () => {
				checked = true;
				return { input_text: "{}", output_text: "" };
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

	it("returns the current revision and field-level diff for stale draft writes", async () => {
		const handlers = createDatasetRouteHandlers({
			pool: () => ({}) as never,
			authorizeDatasetWrite: async () => {},
			upsertDatasetDraftItem: async () => {
				throw new DatasetRepositoryError(
					"CONFLICT",
					"Dataset draft has changed; refresh and retry",
					undefined,
					{
						current_revision: 7,
						field_diff: [
							{
								field: "input",
								current: { question: "newer" },
								requested: { question: "stale" },
							},
						],
					},
				);
			},
		} as never);
		const response = await handlers.handlePutDatasetDraftItem({
			get: () => ({
				actor: "test",
				organizationId: authorization.organization_id,
				actorId: authorization.actor_id,
			}),
			req: {
				header: () => '"4"',
				valid: (part: string) =>
					part === "param"
						? { slug: "golden", itemKey: "stable" }
						: part === "query"
							? { project_id: PROJECT }
							: { input: { question: "stale" } },
			},
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			details: {
				current_revision: 7,
				field_diff: [
					expect.objectContaining({
						field: "input",
						current: { question: "newer" },
						requested: { question: "stale" },
					}),
				],
			},
		});
	});

	it("validates the bounded CSV and JSONL export contract", () => {
		for (const format of ["csv", "jsonl"])
			expect(
				DatasetExportQuery.safeParse({
					project_id: PROJECT,
					format,
					representation: "version",
					version: 1,
				}).success,
			).toBe(true);
		expect(
			DatasetExportQuery.safeParse({
				project_id: PROJECT,
				format: "json",
				representation: "version",
				version: 1,
			}).success,
		).toBe(false);
	});

	it("exports only a complete redacted project-scoped representation with provenance", async () => {
		const queries: string[] = [];
		const result = await exportDataset(
			{
				connect: async () => ({
					query: async (sql: string) => {
						queries.push(sql);
						if (sql.includes("p.status = ANY($3::text[])"))
							return { rows: [{ id: PROJECT }] };
						if (sql.startsWith("SELECT authorization_allows_project"))
							return { rows: [{ allowed: true }] };
						if (sql.includes("FROM datasets dataset"))
							return {
								rows: [
									{
										dataset_id: DATASET,
										slug: "golden",
										source_id: "55555555-5555-4555-8555-555555555555",
										version: 1,
									},
								],
							};
						if (sql.includes("FROM dataset_version_items"))
							return {
								rows: [
									{
										item_key: "case-1",
										input: { question: "do not disclose" },
										expected_output: { answer: "do not disclose" },
										metadata: { source: "manual" },
										external_id: "origin-1",
										source_trace_id: "trace-1",
										source_observation_id: null,
										feedback_score_id: null,
										capture_context: { redaction_applied: true },
										curated_by: authorization.actor_id,
										reviewed_by: null,
										reviewed_at: null,
									},
								],
							};
						if (sql.includes("governance_policy_versions"))
							return { rows: [{ redaction: { mode: "all_text", keys: [] } }] };
						return { rows: [] };
					},
					release() {},
				}),
			} as never,
			{
				project_id: PROJECT,
				slug: "golden",
				format: "jsonl",
				representation: "version",
				version: 1,
				authorization: { ...authorization, operation: "destructive" },
			},
		);

		expect(result.content_type).toBe("application/x-ndjson");
		expect(result.body).toContain('"source_trace_id":"trace-1"');
		expect(result.body).not.toContain("do not disclose");
		expect(queries.some((query) => query.includes("'exported'"))).toBe(true);
	});

	it("blocks tombstoning when immutable evidence, runs, or a retention hold remain", async () => {
		const db = fakeDb([
			{ rows: [] },
			{ rows: [{ id: PROJECT }] },
			{ rows: [] },
			{
				rows: [
					{
						...datasetRow,
						archived_at: NOW,
						lifecycle_revision: 1,
					},
				],
			},
			{
				rows: [
					{
						id: DATASET,
						immutable_versions: 1,
						historical_runs: 1,
						queued_runs: 1,
						scheduled_runs: 0,
						retention_holds: 1,
					},
				],
			},
		]);
		await expect(
			tombstoneDataset(db, {
				project_id: PROJECT,
				slug: "golden",
				revision: 1,
				authorization: { ...authorization, operation: "destructive" },
			}),
		).rejects.toMatchObject<DatasetRepositoryError>({
			code: "CONFLICT",
			details: expect.objectContaining({
				immutable_versions: 1,
				historical_runs: 1,
				queued_runs: 1,
				retention_holds: 1,
			}),
		});
		expect(
			db.queries.some((query) => query.text.startsWith("DELETE FROM datasets")),
		).toBe(false);
	});

	it("registers lifecycle export, restore, and tombstone endpoints", () => {
		const app = new OpenAPIHono();
		app.openapi(exportDatasetRoute, async () => new Response());
		app.openapi(restoreDatasetRoute, async () => new Response());
		app.openapi(tombstoneDatasetRoute, async () => new Response());
		const paths = app.getOpenAPIDocument({
			openapi: "3.1.0",
			info: { title: "test", version: "1" },
		}).paths;
		expect(paths?.["/v1/datasets/by-slug/{slug}/export"]?.get).toBeDefined();
		expect(paths?.["/v1/datasets/by-slug/{slug}/restore"]?.post).toBeDefined();
		expect(
			paths?.["/v1/datasets/by-slug/{slug}/tombstone"]?.delete,
		).toBeDefined();
	});
});
