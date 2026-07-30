import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";

const api = vi.hoisted(() => ({
	listProjects: vi.fn(),
	createProject: vi.fn(),
	updateProject: vi.fn(),
	archiveProject: vi.fn(),
	restoreProject: vi.fn(),
}));

vi.mock("../../src/lib/api", () => api);
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		organizationRole: "owner",
		selectProject: vi.fn(),
	}),
}));

import { ProjectsPage } from "../../src/routes/projects";

const PROJECT = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "Project One",
	slug: "project-one",
	status: "active",
	created_at: "2026-07-15T10:00:00.000Z",
	archived_at: null,
};

function renderPage() {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<ProjectsPage />
		</QueryClientProvider>,
	);
}

describe("ProjectsPage", () => {
	beforeEach(() => {
		Object.values(api).forEach((mock) => mock.mockReset());
		api.listProjects.mockResolvedValue({ items: [PROJECT], total: 1 });
	});
	afterEach(cleanup);

	it("lets owners create, rename, archive, and restore accessible projects", async () => {
		api.createProject.mockResolvedValue({
			...PROJECT,
			id: "22222222-2222-4222-8222-222222222222",
			name: "Project Two",
			slug: "project-two",
		});
		api.updateProject.mockResolvedValue({ ...PROJECT, name: "Renamed" });
		api.archiveProject.mockResolvedValue({
			...PROJECT,
			status: "archived",
			archived_at: "2026-07-16T10:00:00.000Z",
		});
		api.restoreProject.mockResolvedValue(PROJECT);
		renderPage();

		await screen.findByText("Project One");
		fireEvent.change(screen.getByLabelText("Project name"), {
			target: { value: "Project Two" },
		});
		fireEvent.change(screen.getByLabelText("Project slug"), {
			target: { value: "project-two" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create project" }));
		await waitFor(() =>
			expect(api.createProject.mock.calls[0]?.[0]).toEqual({
				name: "Project Two",
				slug: "project-two",
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Rename Project One" }));
		const rename = screen.getByLabelText("New name for Project One");
		fireEvent.change(rename, { target: { value: "Renamed" } });
		fireEvent.click(screen.getByRole("button", { name: "Save name" }));
		await waitFor(() =>
			expect(api.updateProject.mock.calls[0]?.[0]).toEqual({
				id: PROJECT.id,
				name: "Renamed",
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Archive Renamed" }));
		await waitFor(() =>
			expect(api.archiveProject.mock.calls[0]?.[0]).toBe(PROJECT.id),
		);
		fireEvent.click(screen.getByRole("button", { name: "Restore Renamed" }));
		await waitFor(() =>
			expect(api.restoreProject.mock.calls[0]?.[0]).toBe(PROJECT.id),
		);
	});

	it("shows a safe error when a project operation is rejected", async () => {
		api.archiveProject.mockRejectedValue(new Error("Forbidden"));
		renderPage();

		await screen.findByText("Project One");
		fireEvent.click(
			screen.getByRole("button", { name: "Archive Project One" }),
		);
		await screen.findByRole("alert");
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Project operation could not be completed.",
		);
		expect(screen.getByRole("alert")).not.toHaveTextContent("Forbidden");
	});
});
