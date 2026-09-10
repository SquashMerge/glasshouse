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
	projectRole: "user" as "admin" | "user" | "read_only",
}));
const {
	archiveEvaluation,
	createEvaluation,
	listDatasets,
	listExperiments,
	listEvaluations,
	listEvaluationLegacyLinks,
	listDatasetVersions,
	getEvaluationDraft,
	updateEvaluationDraft,
	listEvaluationVersions,
	getEvaluationVersion,
	publishEvaluationDraft,
	restoreEvaluation,
	tombstoneEvaluation,
} = vi.hoisted(() => ({
	archiveEvaluation: vi.fn(),
	createEvaluation: vi.fn(),
	listDatasets: vi.fn(),
	listExperiments: vi.fn(),
	listEvaluations: vi.fn(),
	listEvaluationLegacyLinks: vi.fn(),
	listDatasetVersions: vi.fn(),
	getEvaluationDraft: vi.fn(),
	updateEvaluationDraft: vi.fn(),
	listEvaluationVersions: vi.fn(),
	getEvaluationVersion: vi.fn(),
	publishEvaluationDraft: vi.fn(),
	restoreEvaluation: vi.fn(),
	tombstoneEvaluation: vi.fn(),
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
			project_role: selection.projectRole,
		},
	}),
}));
vi.mock("../../src/lib/api", () => ({
	archiveEvaluation,
	createEvaluation,
	listDatasets,
	listExperiments,
	listEvaluations,
	listEvaluationLegacyLinks,
	listDatasetVersions,
	getEvaluationDraft,
	updateEvaluationDraft,
	listEvaluationVersions,
	getEvaluationVersion,
	publishEvaluationDraft,
	restoreEvaluation,
	tombstoneEvaluation,
}));

import { EvaluationsPage } from "../../src/routes/evaluations";

const PROJECT_ONE = "11111111-1111-4111-8111-111111111111";
const PROJECT_TWO = "22222222-2222-4222-8222-222222222222";
const DATASET_ONE = "33333333-3333-4333-8333-333333333333";
const DATASET_TWO = "44444444-4444-4444-8444-444444444444";
const DATASET_THREE = "55555555-5555-4555-8555-555555555555";
const DATASET_VERSION_ONE = "66666666-6666-4666-8666-666666666666";
const DATASET_VERSION_THREE = "77777777-7777-4777-8777-777777777777";
const EVALUATION_ONE = "88888888-8888-4888-8888-888888888888";
const evaluationOne = {
	id: EVALUATION_ONE,
	project_id: PROJECT_ONE,
	slug: "project-one-evaluation",
	name: "Project One evaluation",
	archived_at: null,
	tombstoned_at: null,
};
const definitionVersionOne = {
	id: "99999999-9999-4999-8999-999999999999",
	evaluation_id: EVALUATION_ONE,
	project_id: PROJECT_ONE,
	version: 1,
	definition_contract: "v1",
	dataset_version_id: DATASET_VERSION_ONE,
	sampling: { strategy: "first_n", sample_size: 1, seed: 0 },
};

const datasets = {
	[PROJECT_ONE]: {
		items: [
			{
				id: DATASET_ONE,
				project_id: PROJECT_ONE,
				slug: "project-one-dataset",
				name: "Project One dataset",
				description: null,
				item_count: 1,
				created_at: "2026-07-29T00:00:00.000Z",
				updated_at: "2026-07-29T00:00:00.000Z",
			},
			{
				id: DATASET_THREE,
				project_id: PROJECT_ONE,
				slug: "project-one-alternate-dataset",
				name: "Project One alternate dataset",
				description: null,
				item_count: 1,
				created_at: "2026-07-29T00:00:00.000Z",
				updated_at: "2026-07-29T00:00:00.000Z",
			},
		],
		total: 2,
	},
	[PROJECT_TWO]: {
		items: [
			{
				id: DATASET_TWO,
				project_id: PROJECT_TWO,
				slug: "project-two-dataset",
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

function runButton() {
	return screen.getByRole("button", { name: "Run evaluation" });
}

describe("EvaluationsPage project-scoped datasets", () => {
	beforeEach(() => {
		selection.projectId = PROJECT_ONE;
		selection.projectName = "Project One";
		selection.projectRole = "user";
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
		archiveEvaluation.mockReset();
		createEvaluation.mockReset();
		publishEvaluationDraft.mockReset();
		restoreEvaluation.mockReset();
		tombstoneEvaluation.mockReset();
	});

	afterEach(cleanup);

	it("keeps Run disabled while the selected immutable version is loading", async () => {
		let resolveVersion:
			| ((value: typeof definitionVersionOne) => void)
			| undefined;
		listEvaluations.mockResolvedValue({ items: [evaluationOne], total: 1 });
		listEvaluationVersions.mockResolvedValue({ items: [definitionVersionOne] });
		getEvaluationVersion.mockImplementation(
			() =>
				new Promise<typeof definitionVersionOne>((resolve) => {
					resolveVersion = resolve;
				}),
		);

		renderPage();
		await screen.findByRole("option", {
			name: "Project One evaluation (project-one-evaluation)",
		});
		fireEvent.change(screen.getByLabelText("Evaluation"), {
			target: { value: evaluationOne.slug },
		});
		await screen.findByRole("option", { name: "Version 1 (v1)" });
		fireEvent.change(screen.getByLabelText("Immutable Definition Version"), {
			target: { value: "1" },
		});

		expect(runButton()).toBeDisabled();
		resolveVersion?.(definitionVersionOne);
		await waitFor(() => expect(runButton()).toBeEnabled());
		expect(getEvaluationVersion).toHaveBeenCalledWith({
			project_id: PROJECT_ONE,
			slug: evaluationOne.slug,
			version: 1,
		});
	});

	it("clears an invalid Definition Version after switching projects", async () => {
		listEvaluations.mockResolvedValue({ items: [evaluationOne], total: 1 });
		listEvaluationVersions.mockResolvedValue({ items: [definitionVersionOne] });
		getEvaluationVersion.mockResolvedValue(definitionVersionOne);
		const page = renderPage();
		await screen.findByRole("option", {
			name: "Project One evaluation (project-one-evaluation)",
		});
		fireEvent.change(screen.getByLabelText("Evaluation"), {
			target: { value: evaluationOne.slug },
		});
		await screen.findByRole("option", { name: "Version 1 (v1)" });
		fireEvent.change(screen.getByLabelText("Immutable Definition Version"), {
			target: { value: "1" },
		});

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

		await waitFor(() =>
			expect(screen.getByLabelText("Evaluation")).toHaveValue(""),
		);
		expect(screen.getByLabelText("Immutable Definition Version")).toHaveValue(
			"",
		);
		expect(runButton()).toBeDisabled();
	});

	it("clears a Definition Dataset Version when its Dataset changes", async () => {
		listDatasetVersions.mockImplementation(({ slug }: { slug: string }) =>
			Promise.resolve({
				items:
					slug === "project-one-dataset"
						? [{ id: DATASET_VERSION_ONE, version: 1 }]
						: [{ id: DATASET_VERSION_THREE, version: 2 }],
			}),
		);
		createEvaluation.mockResolvedValue({});
		renderPage();

		await screen.findAllByRole("option", { name: "Project One dataset" });
		fireEvent.change(screen.getByLabelText("Definition dataset"), {
			target: { value: DATASET_ONE },
		});
		await screen.findByRole("option", { name: "Version 1" });
		fireEvent.change(screen.getByLabelText("Definition name"), {
			target: { value: "Project One quality" },
		});
		fireEvent.change(screen.getByLabelText("Stable ID"), {
			target: { value: "project-one-quality" },
		});
		fireEvent.change(screen.getByLabelText("Dataset Version"), {
			target: { value: DATASET_VERSION_ONE },
		});
		const create = screen.getByRole("button", {
			name: "Create definition draft",
		});
		await waitFor(() => expect(create).toBeEnabled());

		fireEvent.change(screen.getByLabelText("Definition dataset"), {
			target: { value: DATASET_THREE },
		});
		await waitFor(() =>
			expect(screen.getByLabelText("Dataset Version")).toHaveValue(""),
		);
		expect(create).toBeDisabled();
		fireEvent.click(create);
		expect(createEvaluation).not.toHaveBeenCalled();

		await screen.findByRole("option", { name: "Version 2" });
		fireEvent.change(screen.getByLabelText("Dataset Version"), {
			target: { value: DATASET_VERSION_THREE },
		});
		await waitFor(() => expect(create).toBeEnabled());
		fireEvent.click(create);
		await waitFor(() =>
			expect(createEvaluation).toHaveBeenCalledWith(
				expect.objectContaining({
					definition: expect.objectContaining({
						dataset_version_id: DATASET_VERSION_THREE,
					}),
				}),
			),
		);
	});
	it("keeps definition creation settings separate from pinned run selection", async () => {
		listDatasetVersions.mockResolvedValue({
			items: [{ id: DATASET_VERSION_ONE, version: 1 }],
		});
		listEvaluations.mockResolvedValue({ items: [evaluationOne], total: 1 });
		listEvaluationVersions.mockResolvedValue({ items: [definitionVersionOne] });
		getEvaluationVersion.mockResolvedValue(definitionVersionOne);
		createEvaluation.mockResolvedValue({});
		renderPage();

		await screen.findAllByRole("option", { name: "Project One dataset" });
		fireEvent.change(screen.getByLabelText("Definition dataset"), {
			target: { value: DATASET_ONE },
		});
		await screen.findByRole("option", { name: "Version 1" });
		fireEvent.change(screen.getByLabelText("Definition name"), {
			target: { value: "Project One quality" },
		});
		fireEvent.change(screen.getByLabelText("Stable ID"), {
			target: { value: "project-one-quality" },
		});
		fireEvent.change(screen.getByLabelText("Dataset Version"), {
			target: { value: DATASET_VERSION_ONE },
		});
		fireEvent.change(screen.getByLabelText("Definition model (optional)"), {
			target: { value: "definition-model" },
		});
		fireEvent.change(
			screen.getByLabelText("Definition system prompt (optional)"),
			{
				target: { value: "definition prompt" },
			},
		);
		fireEvent.change(screen.getByLabelText("Definition evaluator"), {
			target: { value: "contains" },
		});
		fireEvent.change(screen.getByLabelText("Definition temperature"), {
			target: { value: "0.4" },
		});

		fireEvent.change(screen.getByLabelText("Evaluation"), {
			target: { value: evaluationOne.slug },
		});
		await screen.findByRole("option", { name: "Version 1 (v1)" });
		fireEvent.change(screen.getByLabelText("Immutable Definition Version"), {
			target: { value: "1" },
		});
		await waitFor(() => expect(runButton()).toBeEnabled());
		expect(screen.queryByLabelText("Model (optional)")).toBeNull();
		expect(screen.queryByLabelText("System prompt (optional)")).toBeNull();
	});

	it("keeps visible pinned-run labels consistently separated from controls", async () => {
		listEvaluations.mockResolvedValue({ items: [evaluationOne], total: 1 });
		listEvaluationVersions.mockResolvedValue({ items: [definitionVersionOne] });
		getEvaluationVersion.mockResolvedValue(definitionVersionOne);
		renderPage();

		await screen.findByRole("option", {
			name: "Project One evaluation (project-one-evaluation)",
		});
		for (const label of ["Evaluation", "Immutable Definition Version"]) {
			expect(screen.getByText(label)).toHaveClass("space-y-2");
		}
		expect(screen.getByLabelText("Evaluation")).toHaveClass(
			"focus-visible:ring-2",
		);
	});
	it("shows an alert and retry when Dataset Version fetching fails without disabling publish", async () => {
		listDatasetVersions.mockRejectedValueOnce(new Error("offline"));
		renderPage();
		await screen.findAllByRole("option", { name: "Project One dataset" });
		fireEvent.change(screen.getByLabelText("Definition dataset"), {
			target: { value: DATASET_ONE },
		});
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
	it("alerts and retries when the selected immutable version cannot load", async () => {
		listEvaluations.mockResolvedValue({ items: [evaluationOne], total: 1 });
		listEvaluationVersions.mockResolvedValue({ items: [definitionVersionOne] });
		getEvaluationVersion
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue(definitionVersionOne);
		renderPage();
		await screen.findByRole("option", {
			name: "Project One evaluation (project-one-evaluation)",
		});
		fireEvent.change(screen.getByLabelText("Evaluation"), {
			target: { value: evaluationOne.slug },
		});
		await screen.findByRole("option", { name: "Version 1 (v1)" });
		fireEvent.change(screen.getByLabelText("Immutable Definition Version"), {
			target: { value: "1" },
		});
		const alerts = await screen.findAllByRole("alert");
		expect(
			alerts.some((alert) =>
				alert.textContent?.includes("Unable to load immutable version"),
			),
		).toBe(true);
		const callsBeforeRetry = getEvaluationVersion.mock.calls.length;
		fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
		await waitFor(() =>
			expect(getEvaluationVersion.mock.calls.length).toBeGreaterThan(
				callsBeforeRetry,
			),
		);
	});
	it("upgrades an incomplete 0076 draft with its GET ETag", async () => {
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
			definition_contract: "legacy_incomplete",
			dataset_version_id: "77777777-7777-4777-8777-777777777777",
			sampling: { strategy: "first_n", sample_size: 1, seed: 0 },
			evaluator: {
				kind: "exact_match",
			},
			target: { kind: "configured_llm" },
			execution_defaults: {},
			limits: { max_cost_usd: 1, max_duration_seconds: 1 },
			thresholds: {},
			updated_at: "2026-01-01T00:00:00.000Z",
		});
		updateEvaluationDraft.mockResolvedValue({});
		renderPage();
		await screen.findByLabelText("Draft model");
		expect(screen.getByText(/This upgraded draft is incomplete/)).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Expected output path"), {
			target: { value: "$.expected_output" },
		});
		fireEvent.change(screen.getByLabelText("Output path"), {
			target: { value: "$.output" },
		});
		fireEvent.change(screen.getAllByLabelText("Temperature")[0]!, {
			target: { value: "0" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
		await waitFor(() =>
			expect(updateEvaluationDraft).toHaveBeenCalledWith({
				project_id: PROJECT_ONE,
				slug: "quality",
				revision: 3,
				definition: {
					dataset_version_id: "77777777-7777-4777-8777-777777777777",
					sampling: { strategy: "first_n", sample_size: 1, seed: 0 },
					evaluator: {
						kind: "exact_match",
						version: "v1",
						expected_output_path: "$.expected_output",
						output_path: "$.output",
					},
					target: {
						kind: "configured_llm",
						model: null,
						system_prompt: null,
					},
					execution_defaults: { temperature: 0, max_tokens: null },
					limits: { max_cost_usd: 1, max_duration_seconds: 1 },
					thresholds: { minimum_pass_rate: null },
				},
			}),
		);
		updateEvaluationDraft.mockRejectedValueOnce(
			new Error("Evaluation draft is at revision 4"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"This draft changed elsewhere",
		);
	});
	it("shows Evaluation lifecycle controls to an Admin", async () => {
		selection.projectRole = "admin";
		listEvaluations.mockResolvedValue({
			items: [
				{
					id: "66666666-6666-4666-8666-666666666666",
					slug: "active-definition",
					name: "Active definition",
					archived_at: null,
					lifecycle_revision: 1,
				},
				{
					id: "77777777-7777-4777-8777-777777777777",
					slug: "archived-definition",
					name: "Archived definition",
					archived_at: "2026-08-29T00:00:00.000Z",
					lifecycle_revision: 2,
				},
			],
			total: 2,
		});
		renderPage();

		await screen.findByRole("button", { name: "Archive" });
		expect(listEvaluations).toHaveBeenCalledWith(PROJECT_ONE, true);
		expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Tombstone" })).toBeTruthy();
	});
	it("renders a tombstoned Evaluation as a terminal retained-evidence state", async () => {
		selection.projectRole = "admin";
		listEvaluations.mockResolvedValue({
			items: [
				{
					id: "66666666-6666-4666-8666-666666666666",
					slug: "tombstoned-definition",
					name: "Tombstoned definition",
					archived_at: "2026-08-29T00:00:00.000Z",
					tombstoned_at: "2026-08-29T01:00:00.000Z",
					lifecycle_revision: 3,
				},
			],
			total: 1,
		});
		renderPage();

		expect(await screen.findByText("Tombstoned")).toBeTruthy();
		expect(
			screen.getByText(
				"Terminal state. Definition Versions and audit evidence are retained but are not enumerable or directly readable.",
			),
		).toBeTruthy();
		expect(
			screen.queryByRole("link", { name: "Tombstoned definition" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Tombstone" })).toBeNull();
		expect(getEvaluationDraft).not.toHaveBeenCalledWith({
			project_id: PROJECT_ONE,
			slug: "tombstoned-definition",
		});
		expect(listEvaluationVersions).not.toHaveBeenCalledWith({
			project_id: PROJECT_ONE,
			slug: "tombstoned-definition",
		});
	});
	it("hides Evaluation mutation controls from a Read-only project role", async () => {
		selection.projectRole = "read_only";
		listEvaluations.mockResolvedValue({
			items: [
				{
					id: "66666666-6666-4666-8666-666666666666",
					slug: "read-only-definition",
					name: "Read-only definition",
					archived_at: null,
					lifecycle_revision: 1,
				},
				{
					id: "77777777-7777-4777-8777-777777777777",
					slug: "archived-definition",
					name: "Archived definition",
					archived_at: "2026-08-29T00:00:00.000Z",
					lifecycle_revision: 2,
				},
			],
			total: 2,
		});
		getEvaluationDraft.mockResolvedValue({
			evaluation_id: "66666666-6666-4666-8666-666666666666",
			project_id: PROJECT_ONE,
			revision: 1,
			definition_contract: "v1",
			dataset_version_id: DATASET_VERSION_ONE,
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
			updated_at: "2026-08-29T00:00:00.000Z",
		});
		renderPage();

		await screen.findByRole("link", { name: "Read-only definition" });
		await screen.findByText(
			"Read-only project access cannot edit or publish definition drafts.",
		);
		expect(listEvaluations).toHaveBeenCalledWith(PROJECT_ONE, false);
		for (const name of [
			"Create definition draft",
			"Run evaluation",
			"Save draft",
			"Publish immutable version",
			"Archive",
			"Restore",
			"Tombstone",
		] as const)
			expect(screen.queryByRole("button", { name })).toBeNull();
		expect(screen.queryByLabelText("Definition dataset")).toBeNull();
		expect(screen.queryByLabelText("Dataset Version ID")).toBeNull();
		expect(archiveEvaluation).not.toHaveBeenCalled();
		expect(restoreEvaluation).not.toHaveBeenCalled();
		expect(tombstoneEvaluation).not.toHaveBeenCalled();
	});
	it("navigates reusable definitions by stable slug without consuming legacy run URLs", async () => {
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
		renderPage();

		expect(
			await screen.findByRole("link", { name: "Quality check" }),
		).toHaveAttribute("href", "/evaluation-definitions/quality-check");
	});
});
