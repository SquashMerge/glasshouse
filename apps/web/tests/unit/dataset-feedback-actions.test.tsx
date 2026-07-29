import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";

const { addDatasetItem, createFeedback, listDatasets } = vi.hoisted(() => ({
	addDatasetItem: vi.fn(),
	createFeedback: vi.fn(),
	listDatasets: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
	addDatasetItem,
	createFeedback,
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

describe("dataset feedback actions", () => {
	it("retains invalid edited JSON and never submits a value wrapper", async () => {
		listDatasets.mockResolvedValue({
			items: [{ id: "dataset", name: "Golden" }],
		});
		addDatasetItem.mockResolvedValue({});
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
		expect(addDatasetItem).not.toHaveBeenCalled();
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
});
