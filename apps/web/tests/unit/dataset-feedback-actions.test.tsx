import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";

const {
	ApiError,
	captureDatasetDraftItem,
	createFeedback,
	getDatasetDraft,
	listDatasets,
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
	captureDatasetDraftItem: vi.fn(),
	createFeedback: vi.fn(),
	getDatasetDraft: vi.fn(),
	listDatasets: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
	ApiError,
	captureDatasetDraftItem,
	createFeedback,
	getDatasetDraft,
	listDatasets,
}));

import {
	AddToDatasetDialog,
	FeedbackControls,
} from "../../src/components/DatasetFeedbackActions";

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

beforeEach(() => {
	getDatasetDraft.mockResolvedValue({ revision: 1 });
});

describe("dataset feedback actions", () => {
	it("does not offer trace capture without Dataset curation access", () => {
		render(
			<AddToDatasetDialog
				projectId="project"
				traceId="trace-a"
				label="trace"
				canCurate={false}
			/>,
		);

		expect(screen.queryByRole("button", { name: "Add to dataset" })).toBeNull();
		expect(listDatasets).not.toHaveBeenCalled();
	});

	it("does not expose accessible feedback mutations without curation access", () => {
		render(
			<FeedbackControls
				projectId="project"
				traceId="trace-a"
				label="trace"
				canCurate={false}
			/>,
		);

		expect(screen.queryByLabelText("Thumbs up trace")).toBeNull();
		expect(screen.queryByLabelText("Thumbs down trace")).toBeNull();
		expect(screen.queryByLabelText("Comment")).toBeNull();
		expect(createFeedback).not.toHaveBeenCalled();
	});

	it("captures only source identity and lets the server redact the source", async () => {
		listDatasets.mockResolvedValue({
			items: [{ id: "dataset", name: "Golden", slug: "golden" }],
		});
		captureDatasetDraftItem.mockResolvedValue({});
		render(
			<AddToDatasetDialog
				projectId="project"
				traceId="trace-a"
				label="trace"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
		await screen.findByRole("dialog");
		fireEvent.change(screen.getByLabelText("Dataset"), {
			target: { value: "dataset" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Capture redacted case" }),
		);
		await waitFor(() =>
			expect(captureDatasetDraftItem).toHaveBeenCalledTimes(1),
		);
		expect(captureDatasetDraftItem).toHaveBeenCalledWith(
			expect.objectContaining({
				project_id: "project",
				slug: "golden",
				revision: 1,
				source_trace_id: "trace-a",
			}),
		);
		expect(
			JSON.stringify(captureDatasetDraftItem.mock.calls[0]?.[0]),
		).not.toContain("question");
	});

	it("retries capture with its original revision and idempotency key", async () => {
		listDatasets.mockResolvedValue({
			items: [{ id: "dataset", name: "Golden", slug: "golden" }],
		});
		getDatasetDraft
			.mockReset()
			.mockResolvedValueOnce({ revision: 1 })
			.mockResolvedValueOnce({ revision: 5 });
		captureDatasetDraftItem
			.mockRejectedValueOnce(new Error("network interrupted"))
			.mockResolvedValueOnce({});
		render(
			<AddToDatasetDialog projectId="project" traceId="trace" label="trace" />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
		await screen.findByRole("dialog");
		fireEvent.change(screen.getByLabelText("Dataset"), {
			target: { value: "dataset" },
		});
		const capture = screen.getByRole("button", {
			name: "Capture redacted case",
		});
		fireEvent.click(capture);
		await screen.findByText("network interrupted");
		fireEvent.click(capture);

		await waitFor(() =>
			expect(captureDatasetDraftItem).toHaveBeenCalledTimes(2),
		);
		const first = captureDatasetDraftItem.mock.calls[0]?.[0] as {
			revision: number;
			idempotency_key: string;
		};
		const second = captureDatasetDraftItem.mock.calls[1]?.[0] as {
			revision: number;
			idempotency_key: string;
		};
		expect(first.revision).toBe(1);
		expect(second.revision).toBe(1);
		expect(second.idempotency_key).toBe(first.idempotency_key);
		expect(getDatasetDraft).toHaveBeenCalledTimes(1);
	});

	it("resets selection when the trace target changes and restores trigger focus on Escape", async () => {
		listDatasets.mockResolvedValue({ items: [] });
		const { rerender } = render(
			<AddToDatasetDialog
				projectId="project"
				traceId="trace-a"
				label="trace"
			/>,
		);
		const trigger = screen.getByRole("button", { name: "Add to dataset" });
		fireEvent.click(trigger);
		await screen.findByRole("dialog");
		fireEvent.change(screen.getByLabelText("Dataset"), {
			target: { value: "dataset" },
		});
		rerender(
			<AddToDatasetDialog
				projectId="project"
				traceId="trace-b"
				label="trace"
			/>,
		);

		expect(screen.getByLabelText("Dataset")).toHaveValue("");
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(trigger).toHaveFocus());
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

	it("does not publish when capture succeeds", async () => {
		listDatasets.mockResolvedValue({
			items: [{ id: "dataset", name: "Golden", slug: "golden" }],
		});
		captureDatasetDraftItem.mockResolvedValue({});
		render(
			<AddToDatasetDialog projectId="project" traceId="trace" label="trace" />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add to dataset" }));
		await screen.findByRole("dialog");
		fireEvent.change(screen.getByLabelText("Dataset"), {
			target: { value: "dataset" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Capture redacted case" }),
		);

		await waitFor(() =>
			expect(captureDatasetDraftItem).toHaveBeenCalledTimes(1),
		);
		expect(getDatasetDraft).toHaveBeenCalledWith({
			project_id: "project",
			slug: "golden",
		});
		expect(captureDatasetDraftItem).toHaveBeenCalledWith(
			expect.objectContaining({
				revision: 1,
				slug: "golden",
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("uses a new capture idempotency key after a successful submission", async () => {
		listDatasets.mockResolvedValue({
			items: [{ id: "dataset", name: "Golden", slug: "golden" }],
		});
		captureDatasetDraftItem.mockResolvedValue({});
		render(
			<AddToDatasetDialog projectId="project" traceId="trace" label="trace" />,
		);
		const trigger = screen.getByRole("button", { name: "Add to dataset" });
		fireEvent.click(trigger);
		await screen.findByRole("dialog");
		fireEvent.change(screen.getByLabelText("Dataset"), {
			target: { value: "dataset" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Capture redacted case" }),
		);
		await waitFor(() =>
			expect(captureDatasetDraftItem).toHaveBeenCalledTimes(1),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		fireEvent.click(trigger);
		await screen.findByRole("dialog");
		fireEvent.change(screen.getByLabelText("Dataset"), {
			target: { value: "dataset" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Capture redacted case" }),
		);
		await waitFor(() =>
			expect(captureDatasetDraftItem).toHaveBeenCalledTimes(2),
		);

		const first = captureDatasetDraftItem.mock.calls[0]?.[0] as {
			idempotency_key: string;
		};
		const second = captureDatasetDraftItem.mock.calls[1]?.[0] as {
			idempotency_key: string;
		};
		expect(second.idempotency_key).not.toBe(first.idempotency_key);
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

	it("sends the latest trimmed comment while requiring a negative reason", async () => {
		createFeedback.mockResolvedValue({});
		render(
			<FeedbackControls projectId="project" traceId="trace" label="trace" />,
		);
		fireEvent.input(screen.getByLabelText("Comment"), {
			target: { value: " Useful response " },
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
