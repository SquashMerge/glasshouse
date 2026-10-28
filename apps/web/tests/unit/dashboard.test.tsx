import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, ...props }: { children: React.ReactNode }) => (
		<a {...props}>{children}</a>
	),
}));

const getOrganizationUsage = vi.fn();
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		selectedProjectId: "11111111-1111-4111-8111-111111111111",
	}),
}));
vi.mock("../../src/lib/api", () => ({
	getOrganizationUsage: (...args: unknown[]) => getOrganizationUsage(...args),
}));

import { DashboardPage } from "../../src/routes/index";

const baseUsage = {
	range: "30d",
	from: "2026-09-28T00:00:00.000Z",
	to: "2026-10-28T00:00:00.000Z",
	projects: [
		{
			id: "11111111-1111-4111-8111-111111111111",
			name: "Assistant",
			slug: "assistant",
			status: "active",
			traces: 4,
			observations: 5,
			observations_by_type: { span: 2, event: 0, generation: 3, tool: 0 },
		},
		{
			id: "22222222-2222-4222-8222-222222222222",
			name: "Archived agent",
			slug: "archived-agent",
			status: "archived",
			traces: 1,
			observations: 1,
			observations_by_type: { span: 0, event: 1, generation: 0, tool: 0 },
		},
		{
			id: "33333333-3333-4333-8333-333333333333",
			name: "Quiet project",
			slug: "quiet-project",
			status: "active",
			traces: 0,
			observations: 0,
			observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
		},
	],
	totals: {
		traces: 5,
		observations: 6,
		observations_by_type: { span: 2, event: 1, generation: 3, tool: 0 },
	},
	series: [
		{
			bucket_start: "2026-10-27T00:00:00.000Z",
			traces: 2,
			observations: 1,
			observations_by_type: { span: 1, event: 0, generation: 0, tool: 0 },
		},
		{
			bucket_start: "2026-10-28T00:00:00.000Z",
			traces: 3,
			observations: 5,
			observations_by_type: { span: 1, event: 1, generation: 3, tool: 0 },
		},
	],
};

function renderDashboard() {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<DashboardPage />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getOrganizationUsage.mockReset();
	getOrganizationUsage.mockImplementation(async () => baseUsage);
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						status: "ok",
						checks: { postgres: "up", clickhouse: "up", valkey: "up" },
					}),
					{ status: 200 },
				),
		),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("organization usage homepage", () => {
	it("shows all organization Projects and aggregate usage regardless of the selected Project", async () => {
		renderDashboard();

		expect(
			await screen.findByRole("heading", { name: "Organization overview" }),
		).toBeInTheDocument();
		expect(await screen.findByText("Assistant")).toBeInTheDocument();
		expect(screen.getByText("Archived agent")).toBeInTheDocument();
		expect(screen.getByText("Quiet project")).toBeInTheDocument();
		expect(screen.getByText("5", { selector: "strong" })).toBeInTheDocument();
		expect(screen.getByText("6", { selector: "strong" })).toBeInTheDocument();
		expect(screen.getByText("Archived")).toBeInTheDocument();
		expect(
			screen.getByText("span 2 · event 0 · generation 3 · tool 0"),
		).toBeInTheDocument();
		expect(await screen.findByText("Postgres: up")).toBeInTheDocument();
		expect(screen.queryByText("Recent traces")).not.toBeInTheDocument();
		expect(screen.queryByText("failed traces")).not.toBeInTheDocument();
		expect(getOrganizationUsage).toHaveBeenCalledWith("30d");
	});

	it("changes the selected UTC range without narrowing the dashboard to a Project", async () => {
		getOrganizationUsage.mockImplementation(async (range: string) => ({
			...baseUsage,
			range,
		}));
		renderDashboard();

		const rangeSelect = await screen.findByLabelText("Usage time range");
		fireEvent.change(rangeSelect, { target: { value: "7d" } });
		expect(getOrganizationUsage).toHaveBeenLastCalledWith("7d");
		expect(screen.getByText("7 days")).toBeInTheDocument();
	});

	it("preserves setup guidance when there is no telemetry in the selected range", async () => {
		getOrganizationUsage.mockImplementation(async () => ({
			...baseUsage,
			projects: baseUsage.projects.map((project) => ({
				...project,
				traces: 0,
				observations: 0,
				observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
			})),
			totals: {
				traces: 0,
				observations: 0,
				observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
			},
			series: baseUsage.series.map((bucket) => ({
				...bucket,
				traces: 0,
				observations: 0,
				observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
			})),
		}));
		renderDashboard();

		expect(
			await screen.findByRole("heading", { name: "Connect telemetry" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Copy OTLP setup" }),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "API reference" })).toHaveAttribute(
			"href",
			"/reference",
		);
	});

	it("keeps service health visible while usage is still loading", async () => {
		getOrganizationUsage.mockImplementation(() => new Promise(() => {}));
		renderDashboard();

		expect(screen.getByLabelText("Usage summary")).toHaveAttribute(
			"aria-busy",
			"true",
		);
		expect(await screen.findByText("Postgres: up")).toBeInTheDocument();
		expect(screen.getByLabelText("Service health")).toBeInTheDocument();
	});

	it("keeps service health visible on usage errors and retries successfully", async () => {
		getOrganizationUsage
			.mockRejectedValueOnce(new Error("usage unavailable"))
			.mockResolvedValueOnce(baseUsage);
		renderDashboard();

		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(
			screen.getByText("Could not load organization usage."),
		).toBeInTheDocument();
		expect(await screen.findByText("ClickHouse: up")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("Assistant")).toBeInTheDocument();
		expect(getOrganizationUsage).toHaveBeenCalledTimes(2);
	});

	it("renders zero-count chart buckets without false activity bars", async () => {
		getOrganizationUsage.mockImplementation(async () => ({
			...baseUsage,
			projects: baseUsage.projects.map((project) => ({
				...project,
				traces: 0,
				observations: 0,
				observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
			})),
			totals: {
				traces: 0,
				observations: 0,
				observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
			},
			series: baseUsage.series.map((bucket) => ({
				...bucket,
				traces: 0,
				observations: 0,
				observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
			})),
		}));
		renderDashboard();

		const chart = await screen.findByRole("img", {
			name: "Persisted telemetry trend with 2 UTC time buckets",
		});
		const bars = chart.querySelectorAll(".bg-primary\\/90, .bg-accent");
		expect(bars).toHaveLength(4);
		for (const bar of bars) {
			expect(bar).toHaveStyle({ height: "0%" });
			expect(bar).not.toHaveClass("min-h-0.5");
		}
	});

	it("keeps the summary, trend, Projects, and health card visually separated", async () => {
		const { container } = renderDashboard();
		await screen.findByText("Assistant");
		expect(container.querySelector("main")).toHaveClass("space-y-8");
		expect(screen.getByLabelText("Usage summary")).toHaveClass("gap-6");
		expect(screen.getByLabelText("Project usage")).toHaveClass("gap-6");
		expect(
			within(screen.getByLabelText("Service health")).getByText(
				"Service health",
			),
		).toBeInTheDocument();
	});
});
