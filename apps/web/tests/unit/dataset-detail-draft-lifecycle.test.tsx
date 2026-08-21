import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";

const {
	ApiError,
	createDataset,
	createDatasetDraft,
	deleteDatasetDraftItem,
	getDataset,
	getDatasetDraft,
	importDatasetDraftItems,
	listDatasetItems,
	listDatasets,
	publishDatasetDraft,
	upsertDatasetDraftItem,
} = vi.hoisted(() => ({
	ApiError: class ApiError extends Error {
		constructor(
			readonly status: number,
			readonly code: string,
			message: string,
		) {
			super(message);
		}
	},
	createDataset: vi.fn(),
	createDatasetDraft: vi.fn(),
	deleteDatasetDraftItem: vi.fn(),
	getDataset: vi.fn(),
	getDatasetDraft: vi.fn(),
	importDatasetDraftItems: vi.fn(),
	listDatasetItems: vi.fn(),
	listDatasets: vi.fn(),
	publishDatasetDraft: vi.fn(),
	upsertDatasetDraftItem: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	useParams: () => ({ id: "22222222-2222-4222-8222-222222222222" }),
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		selectedProjectId: "11111111-1111-4111-8111-111111111111",
	}),
}));
vi.mock("../../src/lib/api", () => ({
	ApiError,
	createDataset,
	createDatasetDraft,
	deleteDatasetDraftItem,
	getDataset,
	getDatasetDraft,
	importDatasetDraftItems,
	listDatasetItems,
	listDatasets,
	publishDatasetDraft,
	upsertDatasetDraftItem,
}));

import { DatasetDetailPage } from "../../src/routes/datasets";

const projectId = "11111111-1111-4111-8111-111111111111";
const datasetId = "22222222-2222-4222-8222-222222222222";

const dataset = {
	id: datasetId,
	project_id: projectId,
	slug: "golden",
	name: "Golden",
	description: null,
	tags: [],
	latest_published_version: 1,
	archived_at: null,
	item_count: 1,
	created_at: "2026-08-14T00:00:00.000Z",
	updated_at: "2026-08-14T00:00:00.000Z",
};

const publishedItem = {
	id: "33333333-3333-4333-8333-333333333333",
	dataset_id: datasetId,
	item_key: "stable-case",
	input: { question: "published" },
	expected_output: { answer: "published" },
	metadata: {},
	source_trace_id: null,
	source_observation_id: null,
	created_at: "2026-08-14T00:00:00.000Z",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function renderPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<DatasetDetailPage />
			</QueryClientProvider>,
		),
	};
}

describe("DatasetDetailPage draft lifecycle", () => {
	beforeEach(() => {
		getDataset.mockResolvedValue(dataset);
		getDatasetDraft.mockResolvedValue({ revision: 4 });
		createDatasetDraft.mockResolvedValue({ revision: 4 });
		publishDatasetDraft.mockResolvedValue({ version: 2, item_count: 1 });
	});

	afterEach(() => {
		cleanup();
		vi.resetAllMocks();
	});

	it("adds cases to the shared draft without publishing", async () => {
		listDatasetItems.mockResolvedValue({ items: [] });
		upsertDatasetDraftItem.mockResolvedValue({
			id: "44444444-4444-4444-8444-444444444444",
			item_key: "new-case",
			input: { question: "new" },
			expected_output: null,
			metadata: {},
			source_trace_id: null,
			source_observation_id: null,
			position: 0,
		});
		renderPage();

		await screen.findByText("Golden");
		fireEvent.change(screen.getByLabelText("Input"), {
			target: { value: '{"question":"new"}' },
		});
		fireEvent.change(screen.getByLabelText("Metadata"), {
			target: { value: "{}" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add case to draft" }));

		await waitFor(() =>
			expect(upsertDatasetDraftItem).toHaveBeenCalledWith(
				expect.objectContaining({
					project_id: projectId,
					slug: "golden",
					revision: 4,
					input: { question: "new" },
				}),
			),
		);
		expect(publishDatasetDraft).not.toHaveBeenCalled();
	});

	it("does not create a draft when manual JSON is invalid", async () => {
		listDatasetItems.mockResolvedValue({ items: [] });
		renderPage();

		await screen.findByText("Golden");
		fireEvent.change(screen.getByLabelText("Input"), {
			target: { value: "not json" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add case to draft" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Unexpected token",
		);
		expect(createDatasetDraft).not.toHaveBeenCalled();
		expect(upsertDatasetDraftItem).not.toHaveBeenCalled();
	});

	it("preserves import provenance through the parser and request", async () => {
		listDatasetItems.mockResolvedValue({ items: [] });
		importDatasetDraftItems.mockResolvedValue({
			items: [],
			revision: 5,
			idempotent: false,
			validation_version: 1,
		});
		renderPage();

		await screen.findByText("Golden");
		fireEvent.change(screen.getByLabelText("JSON array"), {
			target: {
				value: JSON.stringify([
					{
						item_key: "imported",
						input: { question: "hello" },
						source_trace_id: "a".repeat(32),
						source_observation_id: "observation-1",
					},
				]),
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Import into draft" }));

		await waitFor(() =>
			expect(importDatasetDraftItems).toHaveBeenCalledWith(
				expect.objectContaining({
					project_id: projectId,
					slug: "golden",
					revision: 4,
					items: [
						expect.objectContaining({
							source_trace_id: "a".repeat(32),
							source_observation_id: "observation-1",
						}),
					],
				}),
			),
		);
		expect(createDatasetDraft).not.toHaveBeenCalled();
	});

	it("does not create a draft for import provenance without a trace", async () => {
		listDatasetItems.mockResolvedValue({ items: [] });
		renderPage();

		await screen.findByText("Golden");
		fireEvent.change(screen.getByLabelText("JSON array"), {
			target: {
				value: JSON.stringify([
					{
						item_key: "invalid",
						input: { question: "hello" },
						source_observation_id: "observation-1",
					},
				]),
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Import into draft" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"observation provenance requires a trace",
		);
		expect(getDatasetDraft).not.toHaveBeenCalled();
		expect(createDatasetDraft).not.toHaveBeenCalled();
		expect(importDatasetDraftItems).not.toHaveBeenCalled();
	});

	it("keeps an added draft case when a cancelled stale refresh resolves", async () => {
		const staleResponse = deferred<{ items: (typeof publishedItem)[] }>();
		const draftItem = {
			...publishedItem,
			id: "44444444-4444-4444-8444-444444444444",
			input: { question: "new" },
		};
		let staleRequestSignal: AbortSignal | undefined;
		let staleRequestObservedAbort = false;
		let staleResponseDelivered = false;
		listDatasetItems
			.mockResolvedValueOnce({ items: [] })
			.mockImplementationOnce(({ signal }) => {
				staleRequestSignal = signal;
				signal?.addEventListener("abort", () => {
					staleRequestObservedAbort = true;
				});
				return staleResponse.promise.then((response) => {
					staleResponseDelivered = true;
					return response;
				});
			})
			.mockResolvedValue({ items: [draftItem] });
		upsertDatasetDraftItem.mockResolvedValue(draftItem);
		const { client } = renderPage();

		await screen.findByText("Golden");
		void client.invalidateQueries({
			queryKey: ["dataset-items", projectId, datasetId],
		});
		await waitFor(() => expect(listDatasetItems).toHaveBeenCalledTimes(2));
		fireEvent.change(screen.getByLabelText("Input"), {
			target: { value: '{"question":"new"}' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add case to draft" }));

		await waitFor(() =>
			expect(
				screen.getByText(/"question": "new"/, { selector: "pre" }),
			).toBeInTheDocument(),
		);
		await waitFor(() => expect(staleRequestSignal?.aborted).toBe(true));
		expect(staleRequestObservedAbort).toBe(true);
		staleResponse.resolve({ items: [publishedItem] });
		await waitFor(() => expect(staleResponseDelivered).toBe(true));
		await waitFor(() =>
			expect(
				screen.getByText(/"question": "new"/, { selector: "pre" }),
			).toBeInTheDocument(),
		);
	});

	it("uses a published item key to delete its copied draft item without publishing", async () => {
		const draftItem = {
			...publishedItem,
			id: "44444444-4444-4444-8444-444444444444",
		};
		listDatasetItems
			.mockResolvedValueOnce({ items: [publishedItem] })
			.mockResolvedValueOnce({ items: [draftItem] })
			.mockResolvedValue({ items: [] });
		deleteDatasetDraftItem.mockResolvedValue(undefined);
		renderPage();

		fireEvent.click(
			await screen.findByRole("button", { name: "Delete from draft" }),
		);

		await waitFor(() =>
			expect(deleteDatasetDraftItem).toHaveBeenCalledWith({
				project_id: projectId,
				slug: "golden",
				item_id: draftItem.id,
				revision: 4,
			}),
		);
		expect(publishDatasetDraft).not.toHaveBeenCalled();
	});
});
