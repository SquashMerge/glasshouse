import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";

const {
	createDatasetDraft,
	createFeedback,
	listDatasets,
	upsertDatasetDraftItem,
} = vi.hoisted(() => ({
	createDatasetDraft: vi.fn(),
	createFeedback: vi.fn(),
	listDatasets: vi.fn(),
	upsertDatasetDraftItem: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
	createDatasetDraft,
	createFeedback,
	listDatasets,
	upsertDatasetDraftItem,
}));

import {
	AddToDatasetDialog,
	FeedbackControls,
} from "../../src/components/DatasetFeedbackActions";

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

describe("dataset feedback actions", () => {
	it("retains invalid edited JSON and never submits a value wrapper", async () => {
		listDatasets.mockResolvedValue({
			items: [{ id: "dataset", name: "Golden", slug: "golden" }],
		});
		createDatasetDraft.mockResolvedValue({ revision: 1 });
		upsertDatasetDraftItem.mockResolvedValue({});
		render(
			<AddToDatasetDialog
				projectId="project"
				traceId="trace-a"
				inputText='{"question":"one"}'
				outputText='{"answer":"one"}'
				label="trace"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
		await screen.findByRole("dialog");
		fireEvent.change(screen.getByLabelText("Input"), {
			target: { value: "not json" },
		});
		fireEvent.change(screen.getByLabelText("Dataset"), {
			target: { value: "dataset" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add case" }));

		expect(
			await screen.findByText("Input must be valid JSON object"),
		).toBeTruthy();
		expect(upsertDatasetDraftItem).not.toHaveBeenCalled();
	});

	it("resets its draft when the trace target changes and restores trigger focus on Escape", async () => {
		listDatasets.mockResolvedValue({ items: [] });
		const { rerender } = render(
			<AddToDatasetDialog
				projectId="project"
				traceId="trace-a"
				inputText='{"question":"one"}'
				label="trace"
			/>,
		);
		const trigger = screen.getByRole("button", { name: "Add to dataset" });
		fireEvent.click(trigger);
		await screen.findByRole("dialog");
		fireEvent.change(screen.getByLabelText("Input"), {
			target: { value: '{"question":"edited"}' },
		});
		rerender(
			<AddToDatasetDialog
				projectId="project"
				traceId="trace-b"
				inputText='{"question":"two"}'
				label="trace"
			/>,
		);

		expect(screen.getByLabelText("Input")).toHaveValue(
			'{\n  "question": "two"\n}',
		);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(trigger).toHaveFocus());
	});

	it("hydrates delayed trace values before the dialog is opened", async () => {
		listDatasets.mockResolvedValue({ items: [] });
		const { rerender } = render(
			<AddToDatasetDialog projectId="project" traceId="trace" label="trace" />,
		);
		rerender(
			<AddToDatasetDialog
				projectId="project"
				traceId="trace"
				inputText='{"question":"delayed"}'
				outputText='{"answer":"delayed"}'
				label="trace"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
		await screen.findByRole("dialog");
		expect(screen.getByLabelText("Input")).toHaveValue(
			'{\n  "question": "delayed"\n}',
		);
		expect(screen.getByLabelText("Expected output suggestion")).toHaveValue(
			'{\n  "answer": "delayed"\n}',
		);
	});

	it("shows dataset loading failures and retries without an unhandled rejection", async () => {
		let rejectDatasets!: (reason?: unknown) => void;
		listDatasets
			.mockImplementationOnce(
				() =>
					new Promise<never>((_resolve, reject) => {
						rejectDatasets = reject;
					}),
			)
			.mockResolvedValueOnce({
				items: [{ id: "dataset", name: "Golden", slug: "golden" }],
			});
		render(
			<AddToDatasetDialog projectId="project" traceId="trace" label="trace" />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));

		expect(
			await screen.findByTestId("dataset-options-skeleton"),
		).toHaveAttribute("aria-label", "Loading choices");
		expect(
			screen.getByRole("combobox", { name: "Dataset" }),
		).toBeInTheDocument();
		expect(screen.queryByText("Loading datasets...")).not.toBeInTheDocument();
		rejectDatasets(new Error("Dataset service unavailable"));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Dataset service unavailable",
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry datasets" }));

		await waitFor(() =>
			expect(screen.getByRole("option", { name: "Golden" })).toBeTruthy(),
		);
	});

	it("traps focus in the dataset dialog and restores the trigger on Escape", async () => {
		listDatasets.mockResolvedValue({ items: [] });
		render(
			<AddToDatasetDialog projectId="project" traceId="trace" label="trace" />,
		);
		const trigger = screen.getByRole("button", { name: "Add to dataset" });
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog");
		const dataset = screen.getByLabelText("Dataset");
		const cancel = screen.getByRole("button", { name: "Cancel" });

		expect(dataset).toHaveFocus();
		fireEvent.keyDown(dataset, { key: "Tab", shiftKey: true });
		expect(cancel).toHaveFocus();
		fireEvent.keyDown(cancel, { key: "Tab" });
		expect(dataset).toHaveFocus();
		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(trigger).toHaveFocus());
	});

	it("leaves absent source output blank and submits null expected output", async () => {
		listDatasets.mockResolvedValue({
			items: [{ id: "dataset", name: "Golden", slug: "golden" }],
		});
		createDatasetDraft.mockResolvedValue({ revision: 1 });
		upsertDatasetDraftItem.mockResolvedValue({});
		render(
			<AddToDatasetDialog
				projectId="project"
				traceId="trace"
				inputText='{"question":"one"}'
				label="trace"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
		await screen.findByRole("dialog");
		expect(screen.getByLabelText("Expected output suggestion")).toHaveValue("");
		fireEvent.change(screen.getByLabelText("Dataset"), {
			target: { value: "dataset" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add case" }));

		await waitFor(() =>
			expect(upsertDatasetDraftItem).toHaveBeenCalledTimes(1),
		);
		expect(createDatasetDraft).toHaveBeenCalledWith({
			project_id: "project",
			slug: "golden",
		});
		expect(upsertDatasetDraftItem).toHaveBeenCalledWith(
			expect.objectContaining({
				expected_output: null,
				revision: 1,
				slug: "golden",
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("reuses one idempotency key when an explicit thumb submission is retried", async () => {
		createFeedback.mockRejectedValueOnce(new Error("network interrupted"));
		createFeedback.mockResolvedValueOnce({});
		render(
			<FeedbackControls projectId="project" traceId="trace" label="trace" />,
		);
		const thumbsUp = screen.getByRole("button", { name: "Thumbs up trace" });
		fireEvent.click(thumbsUp);
		await screen.findByText("network interrupted");
		fireEvent.click(thumbsUp);
		await waitFor(() => expect(createFeedback).toHaveBeenCalledTimes(2));
		const first = createFeedback.mock.calls[0]?.[0] as {
			idempotency_key?: string;
		};
		const second = createFeedback.mock.calls[1]?.[0] as {
			idempotency_key?: string;
		};
		expect(first.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
		expect(second.idempotency_key).toBe(first.idempotency_key);
	});

	it("uses a new retry key after switching feedback targets", async () => {
		createFeedback.mockRejectedValueOnce(new Error("network interrupted"));
		createFeedback.mockResolvedValueOnce({});
		const { rerender } = render(
			<FeedbackControls projectId="project" traceId="trace-a" label="trace" />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Thumbs up trace" }));
		await screen.findByText("network interrupted");
		const first = createFeedback.mock.calls[0]?.[0] as {
			idempotency_key: string;
		};

		rerender(
			<FeedbackControls projectId="project" traceId="trace-b" label="trace" />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Thumbs up trace" }));
		await waitFor(() => expect(createFeedback).toHaveBeenCalledTimes(2));
		const second = createFeedback.mock.calls[1]?.[0] as {
			idempotency_key: string;
			trace_id: string;
		};

		expect(second.idempotency_key).not.toBe(first.idempotency_key);
		expect(second.trace_id).toBe("trace-b");
	});

	it("records an optional positive comment while requiring a negative reason", async () => {
		createFeedback.mockResolvedValue({});
		render(
			<FeedbackControls projectId="project" traceId="trace" label="trace" />,
		);
		fireEvent.change(screen.getByLabelText("Comment"), {
			target: { value: "Useful response" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Thumbs up trace" }));
		await waitFor(() => expect(createFeedback).toHaveBeenCalledTimes(1));
		expect(createFeedback).toHaveBeenCalledWith(
			expect.objectContaining({
				value: 1,
				metadata: {
					feedback: expect.objectContaining({
						sentiment: "positive",
						comment: "Useful response",
					}),
				},
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Thumbs down trace" }));
		fireEvent.click(screen.getByRole("button", { name: "Record" }));
		expect(createFeedback).toHaveBeenCalledTimes(1);
		expect(screen.getByLabelText("Reason")).toBeTruthy();
	});
});
