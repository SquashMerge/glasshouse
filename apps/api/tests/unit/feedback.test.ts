import { describe, expect, it } from "bun:test";
import {
	requestHash,
	createFeedback,
	getFeedbackPromotionTarget,
	listFeedback,
	promoteFeedback,
	reviewFeedback,
} from "../../src/db/feedback";
import { datasetCurationRequestHash } from "../../src/db/datasets";
import { FeedbackCreate, FeedbackReview } from "../../src/schemas/feedback";

const base = {
	project_id: "11111111-1111-4111-8111-111111111111",
	trace_id: "a".repeat(32),
	value: -1 as const,
	metadata: {
		feedback: {
			schema_version: 1 as const,
			sentiment: "negative" as const,
			reason: "incorrect_answer",
		},
	},
};
const authorization = {
	organization_id: "22222222-2222-4222-8222-222222222222",
	actor_id: "33333333-3333-4333-8333-333333333333",
	operation: "product_write" as const,
};

describe("feedback contract", () => {
	it("accepts only typed human feedback payloads", () => {
		expect(FeedbackCreate.safeParse(base).success).toBe(true);
		expect(
			FeedbackCreate.safeParse({
				...base,
				metadata: {
					feedback: { ...base.metadata.feedback, sentiment: "positive" },
				},
			}).success,
		).toBe(true);
		expect(FeedbackCreate.safeParse({ ...base, value: 0 }).success).toBe(false);
	});

	it("persists and returns a typed comment from score metadata", async () => {
		const comment = "Helpful first-pass trace";
		const now = new Date("2026-09-10T12:00:00.000Z");
		const inserted: unknown[][] = [];
		const row = {
			id: "33333333-3333-4333-8333-333333333333",
			project_id: base.project_id,
			trace_id: base.trace_id,
			observation_id: null,
			value: 1,
			metadata: {
				feedback: { schema_version: 1, sentiment: "positive", comment },
			},
			created_at: now,
			status: "reviewed",
			note: null,
			dataset_id: null,
			dataset_item_id: null,
			dataset_draft_item_id: null,
			updated_at: now,
		};
		const client = {
			query: async (sql: string, values?: unknown[]) => {
				if (sql.includes("FROM projects p WHERE"))
					return { rows: [{ id: base.project_id }] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.includes("FROM feedback_idempotency")) return { rows: [] };
				if (sql.startsWith("INSERT INTO scores")) {
					inserted.push(values ?? []);
					return { rows: [] };
				}
				if (sql.includes("JOIN feedback_reviews")) return { rows: [row] };
				return { rows: [] };
			},
			release() {},
		};
		const result = await createFeedback(
			{ connect: async () => client } as never,
			{
				...base,
				value: 1,
				metadata: {
					feedback: { schema_version: 1, sentiment: "positive", comment },
				},
				idempotency_key: "typed-comment",
				authorization,
			},
		);

		expect(JSON.parse(String(inserted[0]?.[5]))).toEqual({
			feedback: { schema_version: 1, sentiment: "positive", comment },
		});
		expect(result.comment).toBe(comment);
	});

	it("uses canonical request fields for idempotency", () => {
		expect(requestHash(base)).toBe(requestHash({ ...base }));
		expect(requestHash(base)).not.toBe(
			requestHash({ ...base, observation_id: "b".repeat(16) }),
		);
	});

	it("reserves added-to-dataset transitions for the promotion endpoint", () => {
		const dataset_id = "22222222-2222-4222-8222-222222222222";
		const dataset_item_id = "44444444-4444-4444-8444-444444444444";
		expect(FeedbackReview.safeParse({ status: "reviewed" }).success).toBe(true);
		expect(
			FeedbackReview.safeParse({ status: "added_to_dataset", dataset_id })
				.success,
		).toBe(false);
		expect(
			FeedbackReview.safeParse({
				status: "added_to_dataset",
				dataset_id,
				dataset_item_id,
			}).success,
		).toBe(false);
		expect(
			FeedbackReview.safeParse({
				status: "dismissed",
				dataset_id,
				dataset_item_id,
			}).success,
		).toBe(false);
		expect(FeedbackReview.safeParse({ status: "unknown" }).success).toBe(false);
	});
});

describe("feedback review persistence", () => {
	it("replays a committed promotion before rereading discarded draft feedback", async () => {
		const now = new Date("2026-07-29T12:00:00.000Z");
		const feedbackId = "33333333-3333-4333-8333-333333333333";
		const datasetId = "44444444-4444-4444-8444-444444444444";
		const draftItemId = "55555555-5555-4555-8555-555555555555";
		const request = {
			feedback_id: feedbackId,
			dataset_id: datasetId,
			item_key: feedbackId,
		};
		const legacyRequest = {
			...request,
			trace_id: base.trace_id,
			observation_id: null,
		};
		const queries: string[] = [];
		const row = {
			id: feedbackId,
			project_id: base.project_id,
			trace_id: base.trace_id,
			observation_id: null,
			value: -1,
			metadata: base.metadata,
			created_at: now,
			status: "reviewed",
			note: null,
			dataset_id: null,
			dataset_item_id: null,
			dataset_draft_item_id: null,
			updated_at: now,
		};
		const client = {
			query: async (sql: string) => {
				queries.push(sql);
				if (sql.includes("p.status = ANY($3::text[])")) return { rows: [{}] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.startsWith("SELECT id FROM datasets WHERE project_id"))
					return { rows: [{ id: datasetId }] };
				if (sql.includes("FROM dataset_curation_idempotency"))
					return {
						rows: [
							{
								dataset_id: datasetId,
								request_hash: datasetCurationRequestHash(legacyRequest),
								response: {
									draft_id: "66666666-6666-4666-8666-666666666666",
									revision: 3,
									item_ids: [draftItemId],
								},
							},
						],
					};
				if (sql.includes("JOIN feedback_reviews")) return { rows: [row] };
				return { rows: [] };
			},
			release() {},
		};

		const target = await getFeedbackPromotionTarget(
			{ connect: async () => client } as never,
			{
				project_id: base.project_id,
				id: feedbackId,
				dataset_id: datasetId,
				idempotency_key: "discarded-draft-retry-key",
				authorization,
			},
		);

		expect(target).toMatchObject({
			kind: "replay",
			feedback: {
				status: "added_to_dataset",
				dataset_id: datasetId,
				dataset_draft_item_id: draftItemId,
			},
		});
		expect(
			queries.findIndex((sql) =>
				sql.includes("FROM dataset_curation_idempotency"),
			),
		).toBeLessThan(
			queries.findIndex((sql) => sql.includes("JOIN feedback_reviews")),
		);
		expect(
			queries.filter((sql) =>
				sql.includes("FROM dataset_curation_idempotency"),
			),
		).toHaveLength(2);
		expect(queries.some((sql) => sql.startsWith("WITH inserted AS"))).toBe(
			false,
		);
	});

	it("returns the original feedback for the same project idempotency key", async () => {
		const now = new Date("2026-07-29T12:00:00.000Z");
		const row = {
			id: "33333333-3333-4333-8333-333333333333",
			project_id: base.project_id,
			trace_id: base.trace_id,
			observation_id: null,
			value: -1,
			metadata: base.metadata,
			created_at: now,
			status: "new",
			note: null,
			dataset_id: null,
			dataset_item_id: null,
			updated_at: now,
		};
		const client = {
			query: async (sql: string) => {
				if (sql.includes("p.status = ANY($3::text[])")) return { rows: [{}] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.includes("JOIN feedback_reviews")) return { rows: [row] };
				if (sql.includes("SELECT request_hash"))
					return { rows: [{ request_hash: requestHash(base) }] };
				return { rows: [] };
			},
			release: () => {},
		};
		const result = await createFeedback(
			{ connect: async () => client } as never,
			{
				...base,
				idempotency_key: "same-intent",
				authorization,
			},
		);

		expect(result.id).toBe(row.id);
		expect(result.project_id).toBe(base.project_id);
	});

	it("returns feedback after its dataset item association is cleared", async () => {
		const now = new Date("2026-07-29T12:00:00.000Z");
		const row = {
			id: "33333333-3333-4333-8333-333333333333",
			project_id: base.project_id,
			trace_id: base.trace_id,
			observation_id: null,
			value: -1,
			metadata: base.metadata,
			created_at: now,
			status: "reviewed",
			note: null,
			dataset_id: null,
			dataset_item_id: null,
			updated_at: now,
		};
		const result = await listFeedback(
			{
				connect: async () => ({
					query: async (sql: string) =>
						sql.includes("p.status = ANY($3::text[])")
							? { rows: [{}] }
							: sql.startsWith("SELECT authorization_allows_project")
								? { rows: [{ allowed: true }] }
								: sql.includes("COUNT(*)")
									? { rows: [{ total: 1 }] }
									: { rows: [row] },
					release() {},
				}),
			} as never,
			{
				...base,
				limit: 10,
				offset: 0,
				authorization: { ...authorization, operation: "product_read" },
			},
		);

		expect(result).toMatchObject({
			total: 1,
			items: [
				{
					id: row.id,
					status: "reviewed",
					dataset_id: null,
					dataset_item_id: null,
				},
			],
		});
	});

	it("rejects promotion until feedback has been reviewed", async () => {
		const now = new Date("2026-07-29T12:00:00.000Z");
		const queries: string[] = [];
		const client = {
			query: async (sql: string) => {
				queries.push(sql);
				if (sql.includes("p.status = ANY($3::text[])")) return { rows: [{}] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.includes("JOIN feedback_reviews"))
					return {
						rows: [
							{
								id: "33333333-3333-4333-8333-333333333333",
								project_id: base.project_id,
								trace_id: base.trace_id,
								observation_id: null,
								value: -1,
								metadata: base.metadata,
								created_at: now,
								status: "new",
								note: null,
								dataset_id: null,
								dataset_item_id: null,
								updated_at: now,
							},
						],
					};
				return { rows: [] };
			},
			release: () => {},
		};

		await expect(
			promoteFeedback({ connect: async () => client } as never, {
				project_id: base.project_id,
				id: "33333333-3333-4333-8333-333333333333",
				dataset_id: "22222222-2222-4222-8222-222222222222",
				input: { question: "hello" },
				authorization: { ...authorization, operation: "governed" },
			}),
		).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
		expect(queries.some((sql) => sql.includes("FROM datasets"))).toBe(false);
		expect(queries).toContain("ROLLBACK");
	});

	it("maps the immutable feedback ID to the draft item conflict key", async () => {
		const now = new Date("2026-07-29T12:00:00.000Z");
		const feedbackId = "33333333-3333-4333-8333-333333333333";
		const draftId = "44444444-4444-4444-8444-444444444444";
		const queries: Array<{ sql: string; values?: unknown[] }> = [];
		const client = {
			query: async (sql: string, values?: unknown[]) => {
				queries.push({ sql, values });
				if (sql.includes("p.status = ANY($3::text[])")) return { rows: [{}] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.includes("JOIN feedback_reviews"))
					return {
						rows: [
							{
								id: feedbackId,
								project_id: base.project_id,
								trace_id: base.trace_id,
								observation_id: null,
								value: -1,
								metadata: base.metadata,
								created_at: now,
								status: "reviewed",
								note: null,
								dataset_id: null,
								dataset_item_id: null,
								dataset_draft_item_id: null,
								updated_at: now,
							},
						],
					};
				if (sql.startsWith("SELECT id, slug FROM datasets"))
					return { rows: [{ id: "dataset-id", slug: "dataset" }] };
				if (sql.startsWith("SELECT id FROM datasets WHERE project_id"))
					return { rows: [{ id: "dataset-id" }] };
				if (sql.startsWith("WITH inserted AS"))
					return { rows: [{ id: draftId, revision: 2, created: false }] };
				if (sql.startsWith("SELECT dr.* FROM dataset_drafts"))
					return {
						rows: [{ id: draftId, dataset_id: "dataset-id", revision: 2 }],
					};
				if (sql.startsWith("INSERT INTO dataset_draft_items"))
					return {
						rows: [
							{
								id: "item-id",
								project_id: base.project_id,
								item_key: feedbackId,
								position: 0,
								input: { question: "hello" },
								expected_output: { answer: "world" },
								metadata: {},
								validation_version: 1,
								state: "draft",
								capture_context: { kind: "feedback" },
								created_by: authorization.actor_id,
								updated_by: authorization.actor_id,
								created_at: now,
							},
						],
					};
				if (sql.startsWith("UPDATE dataset_drafts SET revision"))
					return { rows: [{ revision: 3 }] };
				if (sql.startsWith("UPDATE feedback_reviews"))
					return { rows: [{ updated_at: now }] };
				return { rows: [] };
			},
			release: () => {},
		};

		await promoteFeedback({ connect: async () => client } as never, {
			project_id: base.project_id,
			id: feedbackId,
			dataset_id: "22222222-2222-4222-8222-222222222222",
			captured_input: { question: "hello" },
			captured_expected_output: { answer: "world" },
			idempotency_key: "feedback-promotion-key",
			authorization: { ...authorization, operation: "governed" },
		});

		const insert = queries.find(({ sql }) =>
			sql.startsWith("INSERT INTO dataset_draft_items"),
		);
		expect(insert?.sql).toContain("feedback_score_id");
		expect(insert?.values).toEqual(
			expect.arrayContaining([
				base.project_id,
				draftId,
				feedbackId,
				JSON.stringify({ question: "hello" }),
				JSON.stringify({ answer: "world" }),
			]),
		);
	});

	it("rejects legacy review promotion rather than writing a mutable dataset item ID", async () => {
		const now = new Date("2026-07-29T12:00:00.000Z");

		for (const status of ["reviewed", "new", "dismissed"] as const) {
			const queries: string[] = [];
			const client = {
				query: async (sql: string) => {
					queries.push(sql);
					if (sql.includes("p.status = ANY($3::text[])")) return { rows: [{}] };
					if (sql.startsWith("SELECT authorization_allows_project"))
						return { rows: [{ allowed: true }] };
					if (sql.includes("JOIN feedback_reviews"))
						return {
							rows: [
								{
									id: "33333333-3333-4333-8333-333333333333",
									project_id: base.project_id,
									trace_id: base.trace_id,
									observation_id: null,
									value: -1,
									metadata: base.metadata,
									created_at: now,
									status,
									note: null,
									dataset_id: null,
									dataset_item_id: null,
									updated_at: now,
								},
							],
						};
					if (sql.includes("UPDATE feedback_reviews"))
						return { rows: [{ updated_at: now }] };
					return { rows: [] };
				},
				release: () => {},
			};

			await expect(
				reviewFeedback({ connect: async () => client } as never, {
					project_id: base.project_id,
					id: "33333333-3333-4333-8333-333333333333",
					status: "added_to_dataset",
					dataset_id: "22222222-2222-4222-8222-222222222222",
					dataset_item_id: "44444444-4444-4444-8444-444444444444",
					authorization: { ...authorization, operation: "governed" },
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				status: 409,
				message:
					status === "reviewed"
						? "Use the feedback promotion endpoint to add feedback through a dataset draft"
						: "Feedback must be reviewed before promotion",
			});
			expect(queries[0]).toBe("BEGIN");
			expect(queries[1]).toContain("FOR UPDATE");
			expect(queries).toContain("ROLLBACK");
			expect(queries.some((sql) => sql.includes("SELECT i.id"))).toBe(false);
			expect(
				queries.some((sql) => sql.includes("UPDATE feedback_reviews")),
			).toBe(false);
		}
	});

	it("returns the already linked feedback without inserting another dataset item when promotion is retried", async () => {
		const now = new Date("2026-07-29T12:00:00.000Z");
		const queries: string[] = [];
		const client = {
			query: async (sql: string) => {
				queries.push(sql);
				if (sql.includes("p.status = ANY($3::text[])")) return { rows: [{}] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.includes("JOIN feedback_reviews"))
					return {
						rows: [
							{
								id: "33333333-3333-4333-8333-333333333333",
								project_id: base.project_id,
								trace_id: base.trace_id,
								observation_id: null,
								value: -1,
								metadata: base.metadata,
								created_at: now,
								status: "added_to_dataset",
								note: null,
								dataset_id: "22222222-2222-4222-8222-222222222222",
								dataset_item_id: "44444444-4444-4444-8444-444444444444",
								updated_at: now,
							},
						],
					};
				return { rows: [] };
			},
			release: () => {},
		};

		const result = await promoteFeedback(
			{ connect: async () => client } as never,
			{
				project_id: base.project_id,
				id: "33333333-3333-4333-8333-333333333333",
				dataset_id: "22222222-2222-4222-8222-222222222222",
				input: { question: "hello" },
				expected_output: { answer: "world" },
				authorization: { ...authorization, operation: "governed" },
			},
		);

		expect(result.status).toBe("added_to_dataset");
		expect(result.dataset_item_id).toBe("44444444-4444-4444-8444-444444444444");
		expect(
			queries.some((sql) => sql.includes("INSERT INTO dataset_items")),
		).toBe(false);
		expect(queries.at(-1)).toBe("COMMIT");
	});

	it("rejects a stale transition after another request has linked the feedback", async () => {
		const now = new Date("2026-07-29T12:00:00.000Z");
		const queries: string[] = [];
		const client = {
			query: async (sql: string) => {
				queries.push(sql);
				if (sql.includes("p.status = ANY($3::text[])")) return { rows: [{}] };
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: true }] };
				if (sql.includes("JOIN feedback_reviews"))
					return {
						rows: [
							{
								id: "33333333-3333-4333-8333-333333333333",
								project_id: base.project_id,
								trace_id: base.trace_id,
								observation_id: null,
								value: -1,
								metadata: base.metadata,
								created_at: now,
								status: "added_to_dataset",
								note: null,
								dataset_id: "22222222-2222-4222-8222-222222222222",
								dataset_item_id: "44444444-4444-4444-8444-444444444444",
								updated_at: now,
							},
						],
					};
				if (sql.startsWith("SELECT authorization_allows_project"))
					return { rows: [{ allowed: false }] };
				return { rows: [] };
			},
			release: () => {},
		};
		await expect(
			reviewFeedback({ connect: async () => client } as never, {
				project_id: base.project_id,
				id: "33333333-3333-4333-8333-333333333333",
				status: "dismissed",
				authorization: { ...authorization, operation: "governed" },
			}),
		).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
		expect(queries).toContain("ROLLBACK");
	});

	it("locks active projects for every feedback mutation and excludes archived projects from lists", async () => {
		const calls: string[] = [];
		const client = () => ({
			query: async (sql: string) => {
				calls.push(sql);
				return { rows: [] };
			},
			release: () => {},
		});
		const mutations = [
			() =>
				createFeedback({ connect: async () => client() } as never, {
					...base,
					idempotency_key: "archived",
					authorization,
				}),
			() =>
				promoteFeedback({ connect: async () => client() } as never, {
					project_id: base.project_id,
					id: "33333333-3333-4333-8333-333333333333",
					dataset_id: "22222222-2222-4222-8222-222222222222",
					input: {},
					authorization: { ...authorization, operation: "governed" },
				}),
			() =>
				reviewFeedback({ connect: async () => client() } as never, {
					project_id: base.project_id,
					id: "33333333-3333-4333-8333-333333333333",
					status: "dismissed",
					authorization: { ...authorization, operation: "governed" },
				}),
		];
		for (const mutate of mutations) {
			const before = calls.length;
			await expect(mutate()).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(calls.slice(before)).toContainEqual(
				expect.stringContaining("p.status = ANY($3::text[])"),
			);
		}

		const listed = await listFeedback(
			{
				connect: async () => ({
					query: async (sql: string) => {
						calls.push(sql);
						if (sql.includes("p.status = ANY($3::text[])"))
							return { rows: [{}] };
						if (sql.startsWith("SELECT authorization_allows_project"))
							return { rows: [{ allowed: true }] };
						return { rows: [] };
					},
					release() {},
				}),
			} as never,
			{
				...base,
				limit: 10,
				offset: 0,
				authorization: { ...authorization, operation: "product_read" },
			},
		);
		expect(listed).toEqual({ items: [], total: 0 });
		const reads = calls.filter((sql) => sql.includes("feedback_reviews"));
		expect(reads).toHaveLength(2);
		for (const sql of reads) expect(sql).toContain("p.status='active'");
	});

	it("refuses an unauthorized feedback list before querying feedback rows", async () => {
		const queries: string[] = [];
		await expect(
			listFeedback(
				{
					connect: async () => ({
						query: async (sql: string) => (queries.push(sql), { rows: [] }),
						release() {},
					}),
				} as never,
				{
					...base,
					limit: 10,
					offset: 0,
					authorization: { ...authorization, operation: "product_read" },
				},
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(queries.some((sql) => sql.includes("JOIN feedback_reviews"))).toBe(
			false,
		);
	});
});
