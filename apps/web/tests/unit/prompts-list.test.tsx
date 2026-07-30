import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const { listActivePromptOptimizationActivities, listPrompts } = vi.hoisted(
	() => ({
		listActivePromptOptimizationActivities: vi.fn(),
		listPrompts: vi.fn(),
	}),
);

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to,
		params: _params,
		...props
	}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
		to?: string;
		params?: unknown;
	}) => (
		<a href={to} {...props}>
			{children}
		</a>
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
	listActivePromptOptimizationActivities,
	listPrompts,
}));

import { PromptsPage } from "../../src/routes/prompts";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("PromptsPage", () => {
	beforeEach(() => {
		listPrompts.mockReset();
		listActivePromptOptimizationActivities.mockReset();
		listActivePromptOptimizationActivities.mockResolvedValue({ items: [] });
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

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
		listActivePromptOptimizationActivities.mockResolvedValue({
			items: [
				{
					id: "22222222-2222-4222-8222-222222222222",
					prompt_slug: "daily-summary",
					status: "optimizing",
					source_version: 2,
					target: "system",
					created_at: "2026-07-15T10:00:00.000Z",
					updated_at: "2026-07-15T10:01:00.000Z",
				},
			],
		});
		render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<PromptsPage />
			</QueryClientProvider>,
		);

		const spinner = await screen.findByTestId("optimization-spinner");
		const row = screen.getByTestId("prompt-row");
		expect(row).toHaveTextContent("Optimizing…");
		expect(spinner).toBeInTheDocument();
		expect(
			screen.getByRole("link", {
				name: "View Daily summary optimization status: Optimizing…",
			}),
		).toBeInTheDocument();
		expect(listActivePromptOptimizationActivities).toHaveBeenCalledWith({
			project_id: PROJECT_ID,
		});
	});

	it("reconciles active list status away after a terminal snapshot", async () => {
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
		listActivePromptOptimizationActivities
			.mockResolvedValueOnce({
				items: [
					{
						id: "22222222-2222-4222-8222-222222222222",
						prompt_slug: "daily-summary",
						status: "preparing",
						source_version: 2,
						target: "system",
						created_at: "2026-07-15T10:00:00.000Z",
						updated_at: "2026-07-15T10:01:00.000Z",
					},
				],
			})
			.mockResolvedValueOnce({ items: [] });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<PromptsPage />
			</QueryClientProvider>,
		);

		await screen.findByText("Preparing…");
		await act(async () => {
			await client.invalidateQueries({
				queryKey: ["prompt-optimization-activities", PROJECT_ID],
			});
		});
		expect(listActivePromptOptimizationActivities).toHaveBeenCalledTimes(2);
		await waitFor(() =>
			expect(
				screen.queryByTestId("optimization-status-link"),
			).not.toBeInTheDocument(),
		);
	});
});
