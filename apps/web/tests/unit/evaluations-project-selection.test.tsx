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

const selection = vi.hoisted(() => ({
	projectId: "11111111-1111-4111-8111-111111111111",
	projectName: "Project One",
}));
const {
	createExperiment,
	listPublishedDatasetItems,
	listDatasets,
	listExperiments,
	listEvaluations,
	listEvaluationLegacyLinks,
	listDatasetVersions,
} = vi.hoisted(() => ({
	createExperiment: vi.fn(),
	listPublishedDatasetItems: vi.fn(),
	listDatasets: vi.fn(),
	listExperiments: vi.fn(),
	listEvaluations: vi.fn(),
	listEvaluationLegacyLinks: vi.fn(),
	listDatasetVersions: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		selectedProjectId: selection.projectId,
		selectedProject: {
			id: selection.projectId,
			name: selection.projectName,
		},
	}),
}));
vi.mock("../../src/lib/api", () => ({
	createExperiment,
	listPublishedDatasetItems,
	listDatasets,
	listExperiments,
	listEvaluations,
	listEvaluationLegacyLinks,
	listDatasetVersions,
}));

import { EvaluationsPage } from "../../src/routes/evaluations";

const PROJECT_ONE = "11111111-1111-4111-8111-111111111111";
const PROJECT_TWO = "22222222-2222-4222-8222-222222222222";
const DATASET_ONE = "33333333-3333-4333-8333-333333333333";
const DATASET_TWO = "44444444-4444-4444-8444-444444444444";

const datasets = {
	[PROJECT_ONE]: {
		items: [
			{
				id: DATASET_ONE,
				project_id: PROJECT_ONE,
				name: "Project One dataset",
				description: null,
				item_count: 1,
				created_at: "2026-07-29T00:00:00.000Z",
				updated_at: "2026-07-29T00:00:00.000Z",
			},
		],
		total: 1,
	},
	[PROJECT_TWO]: {
		items: [
			{
				id: DATASET_TWO,
				project_id: PROJECT_TWO,
				name: "Project Two dataset",
				description: null,
				item_count: 1,
				created_at: "2026-07-29T00:00:00.000Z",
				updated_at: "2026-07-29T00:00:00.000Z",
			},
		],
		total: 1,
	},
};

const validItems = {
	items: [
		{
			id: "55555555-5555-4555-8555-555555555555",
			dataset_id: DATASET_ONE,
			input: { question: "What is Astraea?" },
			expected_output: { answer: "An evaluation platform" },
			metadata: {},
			source_trace_id: null,
			source_observation_id: null,
			created_at: "2026-07-29T00:00:00.000Z",
		},
	],
};

function renderPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<EvaluationsPage />
		</QueryClientProvider>,
	);
}

function datasetSelect() {
	return screen.getByLabelText("Dataset") as HTMLSelectElement;
}

function runButton() {
	return screen.getByRole("button", { name: "Run evaluation" });
}

describe("EvaluationsPage project-scoped datasets", () => {
	beforeEach(() => {
		selection.projectId = PROJECT_ONE;
		selection.projectName = "Project One";
		listDatasets.mockImplementation((projectId: string) =>
			Promise.resolve(datasets[projectId as keyof typeof datasets]),
		);
		listExperiments.mockResolvedValue({ items: [], total: 0 });
		listEvaluations.mockResolvedValue({ items: [], total: 0 });
		listEvaluationLegacyLinks.mockResolvedValue({ items: [] });
		listDatasetVersions.mockResolvedValue({ items: [] });
		listPublishedDatasetItems.mockReset();
		createExperiment.mockReset();
	});

	afterEach(cleanup);

	it("keeps Run disabled while the selected dataset items are loading", async () => {
		let resolveItems: ((value: typeof validItems) => void) | undefined;
		listPublishedDatasetItems.mockImplementation(
			() =>
				new Promise<typeof validItems>((resolve) => {
					resolveItems = resolve;
				}),
		);

		renderPage();
		await screen.findByRole("option", { name: "Project One dataset" });
		fireEvent.change(datasetSelect(), { target: { value: DATASET_ONE } });

		expect(runButton()).toBeDisabled();
		resolveItems?.(validItems);
		await waitFor(() => expect(runButton()).toBeEnabled());
		expect(listPublishedDatasetItems).toHaveBeenCalledWith({
			project_id: PROJECT_ONE,
			id: DATASET_ONE,
		});
	});

	it("clears an invalid dataset selection after switching projects", async () => {
		listPublishedDatasetItems.mockResolvedValue(validItems);
		const page = renderPage();
		await screen.findByRole("option", { name: "Project One dataset" });
		fireEvent.change(datasetSelect(), { target: { value: DATASET_ONE } });
		await waitFor(() => expect(runButton()).toBeEnabled());

		selection.projectId = PROJECT_TWO;
		selection.projectName = "Project Two";
		page.rerender(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<EvaluationsPage />
			</QueryClientProvider>,
		);

		await screen.findByRole("option", { name: "Project Two dataset" });
		await waitFor(() => expect(datasetSelect()).toHaveValue(""));
		expect(runButton()).toBeDisabled();
		expect(listPublishedDatasetItems).not.toHaveBeenCalledWith({
			project_id: PROJECT_TWO,
			id: DATASET_ONE,
		});
	});

	it("keeps visible evaluation labels consistently separated from controls", async () => {
		listPublishedDatasetItems.mockResolvedValue(validItems);
		renderPage();

		await screen.findByRole("option", { name: "Project One dataset" });
		for (const label of [
			"Dataset",
			"Evaluation name",
			"Model (optional)",
			"Evaluator",
		]) {
			expect(screen.getByText(label)).toHaveClass("space-y-2");
		}
		expect(screen.getByLabelText("Dataset")).toHaveClass(
			"focus-visible:ring-2",
		);
	});
	it("shows an alert and retry when Dataset Version fetching fails without disabling publish", async () => {
		listDatasetVersions.mockRejectedValueOnce(new Error("offline"));
		listPublishedDatasetItems.mockResolvedValue(validItems);
		renderPage();
		await screen.findByRole("option", { name: "Project One dataset" });
		fireEvent.change(datasetSelect(), { target: { value: DATASET_ONE } });
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Unable to load Dataset Versions");
		const callsBeforeRetry = listDatasetVersions.mock.calls.length;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(listDatasetVersions.mock.calls.length).toBeGreaterThan(
				callsBeforeRetry,
			),
		);
	});
});
