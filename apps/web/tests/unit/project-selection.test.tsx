import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const { listProjects, listPrompts } = vi.hoisted(() => ({
	listProjects: vi.fn(),
	listPrompts: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({ listProjects, listPrompts }));

import {
	ProjectProvider,
	SELECTED_PROJECT_KEY,
	useProjectSelection,
} from "../../src/components/ProjectProvider";
import { PromptsPage } from "../../src/routes/prompts";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const STALE_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function wrapper(children: React.ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function SelectionProbe() {
	const { selectedProjectId, selectedProject } = useProjectSelection();
	return (
		<output data-testid="selection">
			{selectedProjectId}:{selectedProject?.name ?? "none"}
		</output>
	);
}

describe("ProjectProvider", () => {
	beforeEach(() => {
		window.localStorage.clear();
		listProjects.mockReset();
		listPrompts.mockReset();
	});

	afterEach(cleanup);

	it("clears a stale stored UUID and persists the first authenticated project", async () => {
		window.localStorage.setItem(SELECTED_PROJECT_KEY, STALE_PROJECT_ID);
		listProjects.mockResolvedValue({
			items: [
				{
					id: PROJECT_ID,
					name: "Project One",
					slug: "project-one",
					created_at: "2026-07-15T10:00:00.000Z",
				},
			],
			total: 1,
		});

		render(
			wrapper(
				<ProjectProvider>
					<SelectionProbe />
				</ProjectProvider>,
			),
		);

		await waitFor(() =>
			expect(screen.getByTestId("selection")).toHaveTextContent(
				`${PROJECT_ID}:Project One`,
			),
		);
		expect(window.localStorage.getItem(SELECTED_PROJECT_KEY)).toBe(PROJECT_ID);
		expect(listProjects).toHaveBeenCalledTimes(1);
	});

	it("removes an invalid stored value and does not call prompt APIs when no project exists", async () => {
		window.localStorage.setItem(SELECTED_PROJECT_KEY, "not-a-uuid");
		listProjects.mockResolvedValue({ items: [], total: 0 });

		render(
			wrapper(
				<ProjectProvider>
					<PromptsPage />
				</ProjectProvider>,
			),
		);

		await screen.findByText("Select a project to manage its prompts.");
		expect(window.localStorage.getItem(SELECTED_PROJECT_KEY)).toBeNull();
		expect(listPrompts).not.toHaveBeenCalled();
	});
});
