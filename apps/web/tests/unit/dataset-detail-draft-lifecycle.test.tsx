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
	createDataset,
	createDatasetDraft,
	deleteDatasetDraftItem,
	getDataset,
	listDatasetItems,
	listDatasets,
	publishDatasetDraft,
	upsertDatasetDraftItem,
} = vi.hoisted(() => ({
	createDataset: vi.fn(),
	createDatasetDraft: vi.fn(),
	deleteDatasetDraftItem: vi.fn(),
	getDataset: vi.fn(),
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
	createDataset,
	createDatasetDraft,
	deleteDatasetDraftItem,
	getDataset,
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

function renderPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<DatasetDetailPage />
		</QueryClientProvider>,
	);
}

describe("DatasetDetailPage draft lifecycle", () => {
	beforeEach(() => {
		getDataset.mockResolvedValue(dataset);
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

	it("keeps an added draft case visible while its item query refreshes", async () => {
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
		fireEvent.click(screen.getByRole("button", { name: "Add case to draft" }));

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
