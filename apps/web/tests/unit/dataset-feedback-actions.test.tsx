import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	act,
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
	getOwnFeedback,
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
	getOwnFeedback: vi.fn(),
	getDatasetDraft: vi.fn(),
	listDatasets: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
	ApiError,
	captureDatasetDraftItem,
	createFeedback,
	getOwnFeedback,
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
	getOwnFeedback.mockResolvedValue(null);
});

describe("dataset feedback actions", () => {
	it("shows a read-only user a failed feedback load and allows retry without offering mutations", async () => {
		getOwnFeedback
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({
				value: -1,
				sentiment: "negative",
				reason: "incorrect",
				comment: "previous",
			});
		render(
			<FeedbackControls
				projectId="project"
				traceId="trace"
				label="trace"
				canCurate={false}
			/>,
		);
		await screen.findByRole("alert");
		expect(screen.queryByLabelText("Thumbs up trace")).toBeNull();
		expect(screen.queryByLabelText("Comment")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await screen.findByText(/previous/);
		expect(
			(screen.getByLabelText("Thumbs down trace") as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(createFeedback).not.toHaveBeenCalled();
	});

	it("sends one feedback request for rapid pending and repeated recorded clicks", async () => {
		let finish!: (value: unknown) => void;
		createFeedback.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		render(
			<FeedbackControls projectId="project" traceId="trace" label="trace" />,
		);
		const up = screen.getByLabelText("Thumbs up trace") as HTMLButtonElement;
		await waitFor(() => expect(up.disabled).toBe(false));
		act(() => {
			up.click();
			up.click();
			up.click();
		});
		expect(createFeedback).toHaveBeenCalledTimes(1);
		await act(async () => finish({ value: 1, sentiment: "positive" }));
		expect(up.disabled).toBe(true);
		act(() => {
			up.click();
			up.click();
		});
		expect(createFeedback).toHaveBeenCalledTimes(1);
	});
	it("shows saved feedback read-only after curation access is removed", async () => {
		getOwnFeedback.mockResolvedValue({
			value: 1,
			sentiment: "positive",
			comment: "previous feedback",
		});
		render(
			<FeedbackControls
				projectId="project"
				traceId="trace"
				label="trace"
				canCurate={false}
			/>,
		);
		await screen.findByText(/previous feedback/);
		expect(
			screen.getByLabelText("Thumbs up trace").getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			(screen.getByLabelText("Thumbs up trace") as HTMLButtonElement).disabled,
		).toBe(true);
	});
	it("restores the current target's saved feedback and disables repeat submissions", async () => {
		getOwnFeedback.mockResolvedValue({
			value: -1,
			sentiment: "negative",
			reason: "incorrect",
			comment: "Needs work",
		});
		render(
			<FeedbackControls projectId="project" traceId="trace" label="trace" />,
		);
		await waitFor(() =>
			expect(
				screen.getByLabelText("Thumbs down trace").getAttribute("aria-pressed"),
			).toBe("true"),
		);
		expect(screen.getByText(/incorrect/)).toBeTruthy();
		expect(screen.getByText(/Needs work/)).toBeTruthy();
		expect(
			(screen.getByLabelText("Thumbs up trace") as HTMLButtonElement).disabled,
		).toBe(true);
	});
	it("blocks submission on load failure and retries the read", async () => {
		getOwnFeedback
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(null);
		render(
			<FeedbackControls projectId="project" traceId="trace" label="trace" />,
		);
		await screen.findByRole("alert");
		expect(
			(screen.getByLabelText("Thumbs up trace") as HTMLButtonElement).disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Thumbs up trace") as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		expect(createFeedback).not.toHaveBeenCalled();
	});
	it("ignores a late read after switching from trace to span", async () => {
		let resolveOld!: (value: unknown) => void;
		getOwnFeedback
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveOld = resolve;
					}),
			)
			.mockResolvedValueOnce(null);
		const { rerender } = render(
			<FeedbackControls projectId="project" traceId="trace" label="trace" />,
		);
		expect(
			(screen.getByLabelText("Thumbs up trace") as HTMLButtonElement).disabled,
		).toBe(true);
		rerender(
			<FeedbackControls
				projectId="project"
				traceId="trace"
				observationId="span"
				label="span"
			/>,
		);
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Thumbs up span") as HTMLButtonElement).disabled,
			).toBe(false),
		);
		await act(async () =>
			resolveOld({ value: -1, sentiment: "negative", reason: "old trace" }),
		);
		expect(screen.queryByText(/old trace/)).toBeNull();
		expect(
			screen.getByLabelText("Thumbs down span").getAttribute("aria-pressed"),
		).toBe("false");
	});
	it("ignores a late submission after switching targets", async () => {
		let finish!: (value: unknown) => void;
		createFeedback.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const { rerender } = render(
			<FeedbackControls projectId="project" traceId="trace" label="trace" />,
		);
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Thumbs up trace") as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		fireEvent.click(screen.getByLabelText("Thumbs up trace"));
		rerender(
			<FeedbackControls
				projectId="project"
				traceId="trace"
				observationId="span"
				label="span"
			/>,
		);
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Thumbs up span") as HTMLButtonElement).disabled,
			).toBe(false),
		);
		await act(async () =>
			finish({ value: 1, sentiment: "positive", comment: "old result" }),
		);
		expect(screen.queryByText(/old result/)).toBeNull();
		expect(
			screen.getByLabelText("Thumbs up span").getAttribute("aria-pressed"),
		).toBe("false");
	});
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

	it("does not expose accessible feedback mutations without curation access", async () => {
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
		await act(async () => {});
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
		await waitFor(() =>
			expect((thumbsUp as HTMLButtonElement).disabled).toBe(false),
		);
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
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Thumbs up trace") as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		fireEvent.click(screen.getByRole("button", { name: "Thumbs up trace" }));
		await screen.findByText("network interrupted");
		const first = createFeedback.mock.calls[0]?.[0] as {
			idempotency_key: string;
		};

		rerender(
			<FeedbackControls projectId="project" traceId="trace-b" label="trace" />,
		);
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Thumbs up trace") as HTMLButtonElement)
					.disabled,
			).toBe(false),
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
		createFeedback.mockResolvedValue({
			value: 1,
			sentiment: "positive",
			reason: null,
			comment: "Useful response",
		});
		const { rerender } = render(
			<FeedbackControls projectId="project" traceId="trace" label="trace" />,
		);
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Thumbs up trace") as HTMLButtonElement)
					.disabled,
			).toBe(false),
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

		await waitFor(() =>
			expect(
				(screen.getByLabelText("Thumbs down trace") as HTMLButtonElement)
					.disabled,
			).toBe(true),
		);
		rerender(
			<FeedbackControls projectId="project" traceId="other" label="trace" />,
		);
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Thumbs down trace") as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		fireEvent.click(screen.getByRole("button", { name: "Thumbs down trace" }));
		fireEvent.click(screen.getByRole("button", { name: "Record" }));
		expect(createFeedback).toHaveBeenCalledTimes(1);
		expect(screen.getByLabelText("Reason")).toBeTruthy();
	});
});
