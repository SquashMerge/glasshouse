import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";

const projectId = "11111111-1111-4111-8111-111111111111";
const { listDatasets, listFeedback, promoteFeedback, reviewFeedback } =
	vi.hoisted(() => ({
		listDatasets: vi.fn(),
		listFeedback: vi.fn(),
		promoteFeedback: vi.fn(),
		reviewFeedback: vi.fn(),
	}));
const projectSelection = vi.hoisted(() => ({
	role: "user" as "user" | "read_only",
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		selectedProjectId: projectId,
		selectedProject: {
			id: projectId,
			name: "Project One",
			project_role: projectSelection.role,
		},
	}),
}));
vi.mock("../../src/lib/api", () => ({
	listDatasets,
	listFeedback,
	promoteFeedback,
	reviewFeedback,
}));

import { FeedbackPage } from "../../src/routes/feedback";

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
	projectSelection.role = "user";
});

describe("FeedbackPage promotion visibility", () => {
	it("keeps feedback controls visible while the initial list loads", () => {
		listFeedback.mockReturnValue(new Promise(() => undefined));
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		render(
			<QueryClientProvider client={client}>
				<FeedbackPage />
			</QueryClientProvider>,
		);

		expect(
			screen.getByRole("heading", { name: "Feedback" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Needs review" }),
		).toBeInTheDocument();
		expect(screen.getByTestId("feedback-list-skeleton")).toBeInTheDocument();
		expect(screen.queryByText("Loading feedback...")).not.toBeInTheDocument();
	});

	it("exposes Add to dataset only for reviewed feedback", async () => {
		listDatasets.mockResolvedValue({ items: [] });
		listFeedback.mockResolvedValue({
			items: [
				{
					id: "33333333-3333-4333-8333-333333333333",
					project_id: projectId,
					trace_id: "a".repeat(32),
					observation_id: null,
					target_type: "trace",
					value: -1,
					sentiment: "negative",
					reason: "incorrect_answer",
					comment: null,
					status: "new",
					note: null,
					dataset_id: null,
					dataset_item_id: null,
					created_at: "2026-07-29T00:00:00.000Z",
					updated_at: "2026-07-29T00:00:00.000Z",
				},
				{
					id: "44444444-4444-4444-8444-444444444444",
					project_id: projectId,
					trace_id: "b".repeat(32),
					observation_id: null,
					target_type: "trace",
					value: -1,
					sentiment: "negative",
					reason: "incorrect_answer",
					comment: null,
					status: "reviewed",
					note: null,
					dataset_id: null,
					dataset_item_id: null,
					created_at: "2026-07-29T00:00:00.000Z",
					updated_at: "2026-07-29T00:00:00.000Z",
				},
			],
			total: 2,
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		render(
			<QueryClientProvider client={client}>
				<FeedbackPage />
			</QueryClientProvider>,
		);

		await screen.findByText(/trace · reviewed/);
		expect(
			screen.getAllByRole("button", { name: "Add to dataset" }),
		).toHaveLength(1);
	});

	it("does not offer feedback promotion to a Read-only project user", async () => {
		projectSelection.role = "read_only";
		listFeedback.mockResolvedValue({
			items: [
				{
					id: "44444444-4444-4444-8444-444444444444",
					project_id: projectId,
					trace_id: "b".repeat(32),
					observation_id: null,
					target_type: "trace",
					value: -1,
					sentiment: "negative",
					reason: "incorrect_answer",
					comment: null,
					status: "reviewed",
					note: null,
					dataset_id: null,
					dataset_item_id: null,
					created_at: "2026-07-29T00:00:00.000Z",
					updated_at: "2026-07-29T00:00:00.000Z",
				},
			],
			total: 1,
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		render(
			<QueryClientProvider client={client}>
				<FeedbackPage />
			</QueryClientProvider>,
		);

		await screen.findByText(/trace · reviewed/);
		expect(screen.queryByRole("button", { name: "Add to dataset" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Mark reviewed" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
		expect(listDatasets).not.toHaveBeenCalled();
	});

	it("announces a feedback row dataset-load failure and retries", async () => {
		listFeedback.mockResolvedValue({
			items: [
				{
					id: "44444444-4444-4444-8444-444444444444",
					project_id: projectId,
					trace_id: "b".repeat(32),
					observation_id: null,
					target_type: "trace",
					value: -1,
					sentiment: "negative",
					reason: "incorrect_answer",
					comment: null,
					status: "reviewed",
					note: null,
					dataset_id: null,
					dataset_item_id: null,
					created_at: "2026-07-29T00:00:00.000Z",
					updated_at: "2026-07-29T00:00:00.000Z",
				},
			],
			total: 1,
		});
		listDatasets
			.mockRejectedValueOnce(new Error("Dataset service unavailable"))
			.mockResolvedValueOnce({
				items: [{ id: "dataset", name: "Golden", slug: "golden" }],
			});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<FeedbackPage />
			</QueryClientProvider>,
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Dataset service unavailable",
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry datasets" }));
		await waitFor(() => expect(listDatasets).toHaveBeenCalledTimes(2));
		expect(
			await screen.findByRole("option", { name: "Golden" }),
		).toBeInTheDocument();
	});

	it("uses accessible shared select styling for feedback filters", async () => {
		listFeedback.mockResolvedValue({ items: [], total: 0 });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<FeedbackPage />
			</QueryClientProvider>,
		);

		const allFeedback = await screen.findByRole("button", {
			name: "All feedback",
		});
		fireEvent.click(allFeedback);
		const sentiment = await screen.findByLabelText("Sentiment");
		expect(sentiment).toHaveClass("focus-visible:ring-2");
	});
});
