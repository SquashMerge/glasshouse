import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteDatasetDraftItem,
	discardDatasetDraft,
	getDatasetVersion,
	importDatasetDraftItems,
	publishDatasetDraft,
	upsertDatasetDraftItem,
} from "../../src/lib/api";
import { setCredentials } from "../../src/lib/auth";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("dataset API client", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		window.localStorage.clear();
		setCredentials("user", "secret");
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => vi.unstubAllGlobals());

	it("uses the validated path key and sends the draft-item upsert body", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: "22222222-2222-4222-8222-222222222222",
					item_key: "item/key",
					input: { question: "hello" },
					expected_output: null,
					metadata: { source: "test" },
					source_trace_id: null,
					source_observation_id: null,
					position: 0,
				}),
				{ status: 200 },
			),
		);

		const item = await upsertDatasetDraftItem({
			project_id: PROJECT_ID,
			slug: "golden",
			item_key: "item/key",
			revision: 2,
			input: { question: "hello" },
			metadata: { source: "test" },
		});
		expect(item).toMatchObject({
			id: "22222222-2222-4222-8222-222222222222",
			item_key: "item/key",
			input: { question: "hello" },
		});

		expect(fetchMock).toHaveBeenCalledWith(
			`/v1/datasets/by-slug/golden/draft/items/item%2Fkey?project_id=${PROJECT_ID}`,
			expect.objectContaining({
				method: "PUT",
				body: JSON.stringify({
					input: { question: "hello" },
					metadata: { source: "test" },
				}),
			}),
		);
		const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(new Headers(request.headers).get("if-match")).toBe('"2"');
	});

	it("returns immutable version snapshot provenance without feedback content", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: "22222222-2222-4222-8222-222222222222",
					dataset_id: "33333333-3333-4333-8333-333333333333",
					project_id: PROJECT_ID,
					version: 1,
					item_count: 1,
					content_hash: "a".repeat(64),
					validation_version: 1,
					published_by: null,
					published_draft_revision: 1,
					created_at: "2026-08-14T00:00:00.000Z",
					items: [
						{
							id: "44444444-4444-4444-8444-444444444444",
							item_key: "stable-case",
							position: 0,
							validation_version: 1,
							state: "reviewed",
							input: { question: "published" },
							expected_output: null,
							metadata: {},
							external_id: null,
							source_trace_id: null,
							source_observation_id: null,
							feedback_score_id: "55555555-5555-4555-8555-555555555555",
							capture_context: {},
							curated_by: "66666666-6666-4666-8666-666666666666",
							reviewed_by: "77777777-7777-4777-8777-777777777777",
							reviewed_at: "2026-08-14T01:00:00.000Z",
							created_at: "2026-08-14T00:00:00.000Z",
						},
					],
				}),
				{ status: 200 },
			),
		);

		const version = await getDatasetVersion({
			project_id: PROJECT_ID,
			slug: "golden",
			version: 1,
		});
		const provenance: Pick<
			(typeof version.items)[number],
			"feedback_score_id" | "curated_by" | "reviewed_by" | "reviewed_at"
		> = version.items[0]!;
		expect(provenance).toMatchObject({
			feedback_score_id: "55555555-5555-4555-8555-555555555555",
			curated_by: "66666666-6666-4666-8666-666666666666",
			reviewed_by: "77777777-7777-4777-8777-777777777777",
			reviewed_at: "2026-08-14T01:00:00.000Z",
		});
	});

	it("deletes a UUID draft item with its current ETag rather than the legacy item endpoint", async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await deleteDatasetDraftItem({
			project_id: PROJECT_ID,
			slug: "golden",
			item_id: "22222222-2222-4222-8222-222222222222",
			revision: 3,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			`/v1/datasets/by-slug/golden/draft/items/22222222-2222-4222-8222-222222222222?project_id=${PROJECT_ID}`,
			expect.objectContaining({ method: "DELETE" }),
		);
		const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(new Headers(request.headers).get("if-match")).toBe('"3"');
	});

	it("preserves import provenance and omits If-Match when creating a draft", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					items: [],
					validation_version: 1,
					revision: 2,
					idempotent: false,
				}),
				{ status: 200 },
			),
		);
		await importDatasetDraftItems({
			project_id: PROJECT_ID,
			slug: "golden",
			idempotency_key: "import-key",
			items: [
				{
					item_key: "imported",
					input: { question: "hello" },
					source_trace_id: "a".repeat(32),
					source_observation_id: "observation-1",
				},
			],
		});

		const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			`/v1/datasets/by-slug/golden/draft/import?project_id=${PROJECT_ID}`,
		);
		expect(JSON.parse(request.body as string)).toEqual({
			items: [
				{
					item_key: "imported",
					input: { question: "hello" },
					source_trace_id: "a".repeat(32),
					source_observation_id: "observation-1",
				},
			],
		});
		expect(new Headers(request.headers).get("if-match")).toBeNull();
	});

	it("accepts an empty discard response", async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await expect(
			discardDatasetDraft({ project_id: PROJECT_ID, slug: "golden" }),
		).resolves.toBeUndefined();
	});

	it("preserves safe validation details on API errors", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					code: "BAD_REQUEST",
					message: "Dataset draft validation failed",
					details: {
						errors: [
							{
								item_id: null,
								item_key: "bad-row",
								field: "items/0/input",
								code: "OBJECT_REQUIRED",
								message: "Input must be a JSON object",
							},
						],
					},
				}),
				{ status: 400 },
			),
		);

		await expect(
			importDatasetDraftItems({
				project_id: PROJECT_ID,
				slug: "golden",
				idempotency_key: "import-key",
				items: [{ item_key: "bad-row", input: {} }],
			}),
		).rejects.toMatchObject({
			status: 400,
			code: "BAD_REQUEST",
			details: {
				errors: [expect.objectContaining({ item_key: "bad-row" })],
			},
		});
	});

	it("publishes a draft with its current ETag", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ version: 2, item_count: 3 }), {
				status: 200,
			}),
		);
		await expect(
			publishDatasetDraft({
				project_id: PROJECT_ID,
				slug: "golden",
				revision: 4,
			}),
		).resolves.toEqual({ version: 2, item_count: 3 });
		const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			`/v1/datasets/by-slug/golden/draft/publish?project_id=${PROJECT_ID}`,
		);
		expect(new Headers(request.headers).get("if-match")).toBe('"4"');
	});
});
