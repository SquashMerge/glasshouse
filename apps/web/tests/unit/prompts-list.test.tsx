import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";

const {
	getActivePromptOptimization,
	listPrompts,
} = vi.hoisted(() => ({
	getActivePromptOptimization: vi.fn(),
	listPrompts: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		...props
	}: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a {...props}>{children}</a>
	),
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		selectedProjectId: "11111111-1111-4111-8111-111111111111",
		selectedProject: {
			id: "11111111-1111-4111-8111-111111111111",
			name: "Project One",
		},
		isLoading: false,
		error: null,
	}),
}));
vi.mock("../../src/lib/api", () => ({
	getActivePromptOptimization,
	listPrompts,
	promptOptimizationEventsUrl: ({ project_id, id }: { project_id: string; id: string }) =>
		`/v1/prompt-optimizations/${id}/events?project_id=${project_id}`,
}));
vi.mock("../../src/hooks/useEventSource", () => ({
	useEventSource: () => ({
		status: "closed",
		paused: false,
		lastEventAt: null,
		reconnect: vi.fn(),
		debug: {
			framesReceived: 0,
			bufferDepth: 0,
			reconnectAttempts: 0,
			lastError: null,
		},
	}),
}));

import { PromptsPage } from "../../src/routes/prompts";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("PromptsPage", () => {
	beforeEach(() => {
		listPrompts.mockReset();
		getActivePromptOptimization.mockReset();
		getActivePromptOptimization.mockResolvedValue(null);
	});
	afterEach(cleanup);

	it("lists the selected project's name, canonical ID, latest version, and time", async () => {
		listPrompts.mockResolvedValue({
			items: [
				{
					id: "support-agent",
					project_id: PROJECT_ID,
					name: "Support Agent",
					description: null,
					version: 4,
					role: "system",
					source: "Hello",
					model: null,
					settings: {},
					change_summary: "Revise greeting",
					created_by: "admin",
					created_at: "2026-07-15T10:00:00.000Z",
					content_hash: "a".repeat(64),
					diff: null,
				},
			],
			total: 1,
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<PromptsPage />
			</QueryClientProvider>,
		);

		const row = await screen.findByTestId("prompt-row");
		expect(row).toHaveTextContent("Support Agent");
		expect(row).toHaveTextContent("support-agent");
		expect(row).toHaveTextContent("v4");
		expect(row).toHaveTextContent("2026");
		expect(listPrompts).toHaveBeenCalledWith(PROJECT_ID);
	});

	it("shows an active optimization indicator for the matching prompt", async () => {
		listPrompts.mockResolvedValue({
			items: [
				{
					id: "daily-summary",
					project_id: PROJECT_ID,
					name: "Daily summary",
					version: 2,
					created_at: "2026-07-15T10:00:00.000Z",
				},
			],
			total: 1,
		});
		getActivePromptOptimization.mockResolvedValue({
			id: "22222222-2222-4222-8222-222222222222",
			prompt_slug: "daily-summary",
			status: "optimizing",
		});
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<PromptsPage />
			</QueryClientProvider>,
		);

		const row = await screen.findByTestId("prompt-row");
		expect(row).toHaveTextContent("Optimizing…");
		expect(screen.getByTestId("optimization-spinner")).toBeInTheDocument();
		expect(getActivePromptOptimization).toHaveBeenCalledWith({
			project_id: PROJECT_ID,
			slug: "daily-summary",
		});
	});
});
