import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteDatasetDraftItem,
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
			new Response(JSON.stringify({}), { status: 200 }),
		);

		await upsertDatasetDraftItem({
			project_id: PROJECT_ID,
			slug: "golden",
			item_key: "item/key",
			revision: 2,
			input: { question: "hello" },
			metadata: { source: "test" },
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

	it("deletes a draft item with its current ETag rather than the legacy item endpoint", async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await deleteDatasetDraftItem({
			project_id: PROJECT_ID,
			slug: "golden",
			item_key: "item/key",
			revision: 3,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			`/v1/datasets/by-slug/golden/draft/items/item%2Fkey?project_id=${PROJECT_ID}`,
			expect.objectContaining({ method: "DELETE" }),
		);
		const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(new Headers(request.headers).get("if-match")).toBe('"3"');
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
