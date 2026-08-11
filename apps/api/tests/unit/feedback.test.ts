import { describe, expect, it } from "bun:test";
import {
	requestHash,
	createFeedback,
	listFeedback,
	promoteFeedback,
	reviewFeedback,
} from "../../src/db/feedback";
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

	it("uses canonical request fields for idempotency", () => {
		expect(requestHash(base)).toBe(requestHash({ ...base }));
		expect(requestHash(base)).not.toBe(
			requestHash({ ...base, observation_id: "b".repeat(16) }),
		);
	});

	it("requires complete dataset linkage only when a review is added to a dataset", () => {
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
		).toBe(true);
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
				if (sql.includes("authorization_allows_project")) return { rows: [{}] };
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
				query: async (sql: string) =>
					sql.includes("COUNT(*)") ? { rows: [{ total: 1 }] } : { rows: [row] },
			} as never,
			{ ...base, limit: 10, offset: 0 },
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
				if (sql.includes("authorization_allows_project")) return { rows: [{}] };
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

	it("rejects direct dataset additions from new or dismissed feedback", async () => {
		const now = new Date("2026-07-29T12:00:00.000Z");

		for (const status of ["new", "dismissed"] as const) {
			const queries: string[] = [];
			const client = {
				query: async (sql: string) => {
					queries.push(sql);
					if (sql.includes("authorization_allows_project"))
						return { rows: [{}] };
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
					if (sql.includes("SELECT i.id")) return { rows: [{ id: "item" }] };
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
			).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
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
				if (sql.includes("authorization_allows_project")) return { rows: [{}] };
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
				if (sql.includes("authorization_allows_project")) return { rows: [{}] };
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
			expect(calls[before + 1]).toContain("authorization_allows_project");
		}

		const listed = await listFeedback(
			{
				query: async (sql: string) => (calls.push(sql), { rows: [] }),
			} as never,
			{ ...base, limit: 10, offset: 0 },
		);
		expect(listed).toEqual({ items: [], total: 0 });
		const reads = calls.filter((sql) => sql.includes("feedback_reviews"));
		expect(reads).toHaveLength(2);
		for (const sql of reads) expect(sql).toContain("p.status='active'");
	});
});
