import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";

let selectedProjectId: string | null = "first-project";
const listMetrics = vi.fn();
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({ selectedProjectId }),
}));
vi.mock("../../src/lib/metrics-api", () => ({
	listMetrics: (...args: unknown[]) => listMetrics(...args),
}));

import { MetricsPage } from "../../src/routes/metrics";

const row = {
	point_id: "point",
	series_id: "series",
	name: "requests",
	unit: "1",
	metric_type: "sum",
	aggregation_temporality: 1,
	is_monotonic: true,
	time_unix_nano: "1793880000123456789",
	scope_name: "meter",
	scope_version: "1",
	data_point: { asInt: "9007199254740993" },
};

function view() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const element = () => (
		<QueryClientProvider client={client}>
			<MetricsPage />
		</QueryClientProvider>
	);
	return { ...render(element()), element };
}

beforeEach(() => {
	selectedProjectId = "first-project";
	listMetrics.mockReset();
	listMetrics.mockResolvedValue({ items: [row], next_cursor: null });
});
afterEach(cleanup);

it("renders exact values and aggregation semantics with inspectable typed JSON", async () => {
	view();
	expect(
		await screen.findByRole("heading", { name: "requests" }),
	).toBeInTheDocument();
	expect(
		screen.getByText("9007199254740993", { selector: "dd" }),
	).toBeInTheDocument();
	expect(
		screen.getByText("1793880000123456789", { selector: "dd" }),
	).toBeInTheDocument();
	expect(
		screen.getByText("sum · Delta · Monotonic · Unit: 1"),
	).toBeInTheDocument();
	expect(
		screen.getByText("Inspect exact point and attributes"),
	).toBeInTheDocument();
});

it("drops the prior Project's points and filters immediately on Project change", async () => {
	const rendered = view();
	await screen.findByRole("heading", { name: "requests" });
	fireEvent.change(screen.getByLabelText("Metric name (exact match)"), {
		target: { value: "private-name" },
	});
	listMetrics.mockImplementation(() => new Promise(() => {}));
	selectedProjectId = "second-project";
	rendered.rerender(rendered.element());
	expect(
		screen.queryByRole("heading", { name: "requests" }),
	).not.toBeInTheDocument();
	expect(screen.getByLabelText("Metric name (exact match)")).toHaveValue("");
	await waitFor(() =>
		expect(listMetrics).toHaveBeenLastCalledWith(
			"second-project",
			"",
			null,
			expect.any(AbortSignal),
		),
	);
});

it("follows bounded pages and resets pagination when the name filter is applied", async () => {
	listMetrics.mockResolvedValue({ items: [row], next_cursor: "older" });
	view();
	fireEvent.click(await screen.findByRole("button", { name: "Older points" }));
	await waitFor(() =>
		expect(listMetrics).toHaveBeenLastCalledWith(
			"first-project",
			"",
			"older",
			expect.any(AbortSignal),
		),
	);
	fireEvent.change(screen.getByLabelText("Metric name (exact match)"), {
		target: { value: "requests" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
	await waitFor(() =>
		expect(listMetrics).toHaveBeenLastCalledWith(
			"first-project",
			"requests",
			null,
			expect.any(AbortSignal),
		),
	);
});

it("shows recovery guidance on failure and sends no request without a Project", async () => {
	listMetrics.mockRejectedValue(new Error("unavailable"));
	const rendered = view();
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Metrics could not be loaded",
	);
	expect(
		screen.getByRole("button", { name: "Retry metrics" }),
	).toBeInTheDocument();
	selectedProjectId = null;
	listMetrics.mockClear();
	rendered.rerender(rendered.element());
	expect(
		screen.getByText("Select a Project to inspect metrics."),
	).toBeInTheDocument();
	expect(listMetrics).not.toHaveBeenCalled();
});
