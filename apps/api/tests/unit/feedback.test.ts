import { describe, expect, it } from "bun:test";
import {
	requestHash,
	createFeedback,
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

	it("limits review states and link fields", () => {
		expect(FeedbackReview.safeParse({ status: "reviewed" }).success).toBe(true);
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
			},
		);

		expect(result.id).toBe(row.id);
		expect(result.project_id).toBe(base.project_id);
	});

	it("locks the project-scoped feedback row before validating and updating a terminal link", async () => {
		const now = new Date("2026-07-29T12:00:00.000Z");
		const queries: string[] = [];
		const client = {
			query: async (sql: string) => {
				queries.push(sql);
				if (sql.includes("FROM scores s JOIN feedback_reviews"))
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
				if (sql.includes("SELECT i.id")) return { rows: [{ id: "item" }] };
				if (sql.includes("UPDATE feedback_reviews"))
					return { rows: [{ updated_at: now }] };
				return { rows: [] };
			},
			release: () => {},
		};
		const pool = { connect: async () => client };

		await reviewFeedback(pool as never, {
			project_id: base.project_id,
			id: "33333333-3333-4333-8333-333333333333",
			status: "added_to_dataset",
			dataset_id: "22222222-2222-4222-8222-222222222222",
			dataset_item_id: "44444444-4444-4444-8444-444444444444",
		});

		expect(queries[0]).toBe("BEGIN");
		expect(queries[1]).toContain("FOR UPDATE");
		expect(queries.at(-1)).toBe("COMMIT");
	});

	it("rejects a stale transition after another request has linked the feedback", async () => {
		const now = new Date("2026-07-29T12:00:00.000Z");
		const queries: string[] = [];
		const client = {
			query: async (sql: string) => {
				queries.push(sql);
				if (sql.includes("FROM scores s JOIN feedback_reviews"))
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
			}),
		).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
		expect(queries).toContain("ROLLBACK");
	});
});
