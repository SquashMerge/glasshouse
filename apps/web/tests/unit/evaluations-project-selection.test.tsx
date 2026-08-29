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
	getEvaluationDraft,
	updateEvaluationDraft,
	listEvaluationVersions,
	getEvaluationVersion,
} = vi.hoisted(() => ({
	createExperiment: vi.fn(),
	listPublishedDatasetItems: vi.fn(),
	listDatasets: vi.fn(),
	listExperiments: vi.fn(),
	listEvaluations: vi.fn(),
	listEvaluationLegacyLinks: vi.fn(),
	listDatasetVersions: vi.fn(),
	getEvaluationDraft: vi.fn(),
	updateEvaluationDraft: vi.fn(),
	listEvaluationVersions: vi.fn(),
	getEvaluationVersion: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to,
		params,
	}: {
		children: React.ReactNode;
		to: string;
		params?: { id?: string; slug?: string };
	}) => (
		<a
			href={to
				.replace("$id", params?.id ?? "")
				.replace("$slug", params?.slug ?? "")}
		>
			{children}
		</a>
	),
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
	getEvaluationDraft,
	updateEvaluationDraft,
	listEvaluationVersions,
	getEvaluationVersion,
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
		getEvaluationDraft.mockReset();
		updateEvaluationDraft.mockReset();
		listEvaluationVersions.mockResolvedValue({ items: [] });
		getEvaluationVersion.mockReset();
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
	it("alerts and retries when selected published items cannot load", async () => {
		listPublishedDatasetItems.mockRejectedValueOnce(new Error("offline"));
		renderPage();
		await screen.findByRole("option", { name: "Project One dataset" });
		fireEvent.change(datasetSelect(), { target: { value: DATASET_ONE } });
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Unable to load published dataset items");
		const callsBeforeRetry = listPublishedDatasetItems.mock.calls.length;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(listPublishedDatasetItems.mock.calls.length).toBeGreaterThan(
				callsBeforeRetry,
			),
		);
	});
	it("saves an existing draft with its current ETag revision and reports stale conflicts", async () => {
		listEvaluations.mockResolvedValue({
			items: [
				{
					id: "66666666-6666-4666-8666-666666666666",
					slug: "quality",
					name: "Quality",
				},
			],
			total: 1,
		});
		getEvaluationDraft.mockResolvedValue({
			evaluation_id: "66666666-6666-4666-8666-666666666666",
			project_id: PROJECT_ONE,
			revision: 3,
			dataset_version_id: "77777777-7777-4777-8777-777777777777",
			sampling: { strategy: "first_n", sample_size: 1, seed: 0 },
			evaluator: {
				kind: "exact_match",
				version: "v1",
				expected_output_path: "$.expected_output",
				output_path: "$.output",
			},
			target: { kind: "configured_llm", model: null, system_prompt: null },
			execution_defaults: { temperature: 0, max_tokens: null },
			limits: { max_cost_usd: 1, max_duration_seconds: 1 },
			thresholds: { minimum_pass_rate: null },
			updated_at: "2026-01-01T00:00:00.000Z",
		});
		updateEvaluationDraft.mockRejectedValue(
			new Error("Evaluation draft is at revision 4"),
		);
		renderPage();
		await screen.findByLabelText("Draft model");
		fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
		await waitFor(() =>
			expect(updateEvaluationDraft).toHaveBeenCalledWith(
				expect.objectContaining({
					project_id: PROJECT_ONE,
					slug: "quality",
					revision: 3,
				}),
			),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"This draft changed elsewhere",
		);
	});
	it("navigates reusable definitions by stable slug", async () => {
		listEvaluations.mockResolvedValue({
			items: [
				{
					id: "66666666-6666-4666-8666-666666666666",
					slug: "quality-check",
					name: "Quality check",
				},
			],
			total: 1,
		});
		listPublishedDatasetItems.mockResolvedValue(validItems);
		renderPage();

		expect(
			await screen.findByRole("link", { name: "Quality check" }),
		).toHaveAttribute("href", "/evaluations/quality-check");
	});
});
