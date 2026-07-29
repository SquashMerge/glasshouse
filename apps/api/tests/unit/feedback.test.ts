import { describe, expect, it } from "bun:test";
import { requestHash } from "../../src/db/feedback";
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
