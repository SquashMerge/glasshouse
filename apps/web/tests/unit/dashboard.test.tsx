import { describe, expect, it, vi } from "vitest";
import type React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, ...props }: { children: React.ReactNode }) => (
		<a {...props}>{children}</a>
	),
}));

import { DashboardPage } from "../../src/routes/index";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({ selectedProjectId: PROJECT_ID }),
}));
vi.mock("../../src/lib/api", () => ({
	listTraces: vi.fn(async (params: { status?: string }) => ({
		items:
			params.status === "error"
				? []
				: [{ trace_id: "trace-1", name: "llm.call" }],
		total: params.status === "error" ? 2 : 1,
	})),
}));

describe("operations dashboard", () => {
	it("summarizes recent telemetry, failures, and the first-trace action", async () => {
		render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<DashboardPage />
			</QueryClientProvider>,
		);

		expect(
			(await screen.findAllByText("Recent traces")).length,
		).toBeGreaterThan(0);
		expect(await screen.findByText("llm.call")).toBeInTheDocument();
		expect(screen.getByText("2 failed traces")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Copy OTLP setup" }),
		).toBeInTheDocument();
	});
});
