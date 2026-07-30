import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";

const { getCurrentActor, listPrompts } = vi.hoisted(() => ({
	getCurrentActor: vi.fn(),
	listPrompts: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({ getCurrentActor, listPrompts }));

import {
	clearWorkspaceSession,
	ProjectProvider,
	SELECTED_PROJECT_KEY,
	useProjectSelection,
} from "../../src/components/ProjectProvider";
import { PromptsPage } from "../../src/routes/prompts";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const STALE_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR = "owner";
const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const selectionKey = `${SELECTED_PROJECT_KEY}:${ORGANIZATION}:${ACTOR}`;

function wrapper(children: React.ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function SelectionProbe() {
	const { selectedProjectId, selectedProject, projects, selectProject } =
		useProjectSelection();
	return (
		<>
			<output data-testid="selection">
				{selectedProjectId}:{selectedProject?.name ?? "none"}
			</output>
			{projects.map((project) => (
				<button
					key={project.id}
					type="button"
					onClick={() => selectProject(project.id)}
				>
					Select {project.name}
				</button>
			))}
		</>
	);
}

describe("ProjectProvider", () => {
	beforeEach(() => {
		window.localStorage.clear();
		getCurrentActor.mockReset();
		listPrompts.mockReset();
	});

	afterEach(cleanup);

	it("clears a stale stored UUID without selecting the first accessible project", async () => {
		window.localStorage.setItem(selectionKey, STALE_PROJECT_ID);
		getCurrentActor.mockResolvedValue({
			actor_subject: ACTOR,
			organization_id: ORGANIZATION,
			organization_role: "owner",
			projects: [
				{
					id: PROJECT_ID,
					name: "Project One",
					slug: "project-one",
					status: "active",
					created_at: "2026-07-15T10:00:00.000Z",
					archived_at: null,
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
			expect(window.localStorage.getItem(selectionKey)).toBeNull(),
		);
		expect(screen.getByTestId("selection")).toHaveTextContent(`:none`);
		expect(getCurrentActor).toHaveBeenCalledTimes(1);
	});

	it("removes an invalid stored value and does not call prompt APIs when no project exists", async () => {
		window.localStorage.setItem(selectionKey, "not-a-uuid");
		getCurrentActor.mockResolvedValue({
			actor_subject: ACTOR,
			organization_id: ORGANIZATION,
			organization_role: "member",
			projects: [],
		});

		render(
			wrapper(
				<ProjectProvider>
					<PromptsPage />
				</ProjectProvider>,
			),
		);

		await screen.findByText("Select a project to manage its prompts.");
		expect(window.localStorage.getItem(selectionKey)).toBeNull();
		expect(listPrompts).not.toHaveBeenCalled();
	});

	it("removes all cached data for the prior project when switching", async () => {
		const nextProjectId = "33333333-3333-4333-8333-333333333333";
		window.localStorage.setItem(selectionKey, PROJECT_ID);
		getCurrentActor.mockResolvedValue({
			actor_subject: ACTOR,
			organization_id: ORGANIZATION,
			organization_role: "owner",
			projects: [
				{
					id: PROJECT_ID,
					name: "Project One",
					slug: "project-one",
					status: "active",
					created_at: "2026-07-15T10:00:00.000Z",
					archived_at: null,
				},
				{
					id: nextProjectId,
					name: "Project Two",
					slug: "project-two",
					status: "active",
					created_at: "2026-07-16T10:00:00.000Z",
					archived_at: null,
				},
			],
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(["prompts", PROJECT_ID], { items: [] });
		client.setQueryData(["datasets", PROJECT_ID], { items: [] });
		client.setQueryData(["traces", { project_id: PROJECT_ID }], { items: [] });
		client.setQueryData(
			["observations", { filters: { project_id: PROJECT_ID } }],
			{ items: [] },
		);
		client.setQueryData(["prompts", nextProjectId], { items: [] });

		render(
			<QueryClientProvider client={client}>
				<ProjectProvider>
					<SelectionProbe />
				</ProjectProvider>
			</QueryClientProvider>,
		);

		await screen.findByRole("button", { name: "Select Project Two" });
		fireEvent.click(screen.getByRole("button", { name: "Select Project Two" }));
		await waitFor(() =>
			expect(screen.getByTestId("selection")).toHaveTextContent(nextProjectId),
		);
		expect(client.getQueryData(["prompts", PROJECT_ID])).toBeUndefined();
		expect(client.getQueryData(["datasets", PROJECT_ID])).toBeUndefined();
		expect(
			client.getQueryData(["traces", { project_id: PROJECT_ID }]),
		).toBeUndefined();
		expect(
			client.getQueryData([
				"observations",
				{ filters: { project_id: PROJECT_ID } },
			]),
		).toBeUndefined();
		expect(client.getQueryData(["prompts", nextProjectId])).toEqual({
			items: [],
		});
	});

	it("clears cached identity, project data, and selections before a different actor logs in", () => {
		const otherSelectionKey = `${SELECTED_PROJECT_KEY}:${ORGANIZATION}:member`;
		window.localStorage.setItem(selectionKey, PROJECT_ID);
		window.localStorage.setItem(otherSelectionKey, STALE_PROJECT_ID);
		const client = new QueryClient();
		client.setQueryData(["me"], { actor_subject: ACTOR });
		client.setQueryData(["prompts", PROJECT_ID], { items: [] });

		clearWorkspaceSession(client);

		expect(client.getQueryData(["me"])).toBeUndefined();
		expect(client.getQueryData(["prompts", PROJECT_ID])).toBeUndefined();
		expect(window.localStorage.getItem(selectionKey)).toBeNull();
		expect(window.localStorage.getItem(otherSelectionKey)).toBeNull();
	});
});
