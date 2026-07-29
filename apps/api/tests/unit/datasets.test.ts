import { describe, expect, it } from "bun:test";
import {
	addDatasetItem,
	createDataset,
	DatasetRepositoryError,
	deleteDatasetItem,
	listDatasets,
} from "../../src/db/datasets";
import { createDatasetRouteHandlers } from "../../src/routes/datasets";
import {
	DatasetCreate,
	DatasetItem,
	DatasetItemCreate,
} from "../../src/schemas/datasets";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const DATASET = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-27T22:00:00.000Z");

const datasetRow = {
	id: DATASET,
	project_id: PROJECT,
	name: "golden",
	description: null,
	item_count: 0,
	created_at: NOW,
	updated_at: NOW,
};

function fakeDb(
	responses: Array<{ rows?: Record<string, unknown>[]; rowCount?: number }>,
) {
	const queries: Array<{ text: string; values?: unknown[] }> = [];
	return {
		queries,
		query: async (text: string, values?: unknown[]) => {
			queries.push({ text, values });
			return responses.shift() ?? { rows: [], rowCount: 0 };
		},
	};
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
});

describe("dataset repository", () => {
	it("lists only datasets for the requested project", async () => {
		const db = fakeDb([{ rows: [datasetRow], rowCount: 1 }]);
		const result = await listDatasets(db, PROJECT);
		expect(result.items[0]?.id).toBe(DATASET);
		expect(db.queries[0]?.text).toContain("WHERE d.project_id = $1");
		expect(db.queries[0]?.values).toEqual([PROJECT]);
	});

	it("persists trace and observation provenance when adding an item", async () => {
		const itemId = "33333333-3333-4333-8333-333333333333";
		const db = fakeDb([
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
		});
		expect(result.source_trace_id).toBe("a".repeat(32));
		expect(result.source_observation_id).toBe("b".repeat(16));
		expect(db.queries[1]?.text).toContain("source_trace_id");
		expect(db.queries[1]?.values).toContain("a".repeat(32));
	});

	it("maps duplicate dataset names to a conflict", async () => {
		const db = fakeDb([]);
		db.query = async () => {
			throw { code: "23505" };
		};
		await expect(
			createDataset(db, { project_id: PROJECT, name: "golden" }),
		).rejects.toMatchObject<DatasetRepositoryError>({
			code: "CONFLICT",
			status: 409,
		});
	});

	it("keeps feedback-linked items immutable and reports a deletion conflict", async () => {
		const db = fakeDb([]);
		db.query = async () => {
			throw { code: "23503" };
		};
		await expect(
			deleteDatasetItem(db, {
				project_id: PROJECT,
				dataset_id: DATASET,
				item_id: "33333333-3333-4333-8333-333333333333",
			}),
		).rejects.toMatchObject<DatasetRepositoryError>({
			code: "CONFLICT",
			status: 409,
			message: "Dataset item is retained because feedback links it",
		});
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
			project_id: PROJECT,
			trace_id: "a".repeat(32),
			observation_id: "b".repeat(16),
		});
	});
});
