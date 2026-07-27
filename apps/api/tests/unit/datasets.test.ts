import { describe, expect, it } from "bun:test";
import {
	DatasetCreate,
	DatasetItem,
	DatasetItemCreate,
} from "../../src/schemas/datasets";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const DATASET = "22222222-2222-4222-8222-222222222222";

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
			created_at: "2026-07-27T22:00:00.000Z",
		});
		expect(result.success).toBe(true);
	});
});
