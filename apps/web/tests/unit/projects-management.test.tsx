import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";

const api = vi.hoisted(() => ({
	listProjects: vi.fn(),
	createProject: vi.fn(),
	updateProject: vi.fn(),
	archiveProject: vi.fn(),
	restoreProject: vi.fn(),
	deleteProject: vi.fn(),
	getProjectDeletionStatus: vi.fn(),
	setDefaultProject: vi.fn(),
}));

vi.mock("../../src/lib/api", () => api);
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		organizationRole: "admin",
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
	project_role: "admin" as const,
	can_manage: true,
	can_govern: true,
	is_default: true,
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

	it("lets owners create and edit persisted projects", async () => {
		api.createProject.mockResolvedValue({
			...PROJECT,
			id: "22222222-2222-4222-8222-222222222222",
			name: "Project Two",
			slug: "project-two",
		});
		api.updateProject.mockResolvedValue({
			...PROJECT,
			name: "Renamed",
			slug: "renamed-project",
		});
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
		fireEvent.change(screen.getByLabelText("New name for Project One"), {
			target: { value: "Renamed" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save name" }));
		await waitFor(() => expect(api.updateProject).toHaveBeenCalled());
	});

	it("shows sanitized project conflicts and never exposes unknown failures", async () => {
		api.createProject
			.mockRejectedValueOnce(
				Object.assign(new Error("Project slug is already in use"), {
					status: 409,
					code: "CONFLICT",
				}),
			)
			.mockRejectedValueOnce(new Error("password=do-not-render"));
		renderPage();

		await screen.findByText("Project One");
		fireEvent.change(screen.getByLabelText("Project name"), {
			target: { value: "Project Two" },
		});
		fireEvent.change(screen.getByLabelText("Project slug"), {
			target: { value: "project-one" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create project" }));

		expect(
			await screen.findByText("Project slug is already in use"),
		).toHaveAttribute("role", "alert");

		fireEvent.change(screen.getByLabelText("Project slug"), {
			target: { value: "project-two" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create project" }));

		expect(
			await screen.findByText(
				"Project operation could not be completed. Refresh the page and retry.",
			),
		).toHaveAttribute("role", "alert");
		expect(screen.queryByText(/password=do-not-render/)).toBeNull();
	});

	it("does not offer to archive the default project", async () => {
		api.listProjects.mockResolvedValue({
			items: [
				PROJECT,
				{
					...PROJECT,
					id: "22222222-2222-4222-8222-222222222222",
					name: "Project Two",
					slug: "project-two",
					is_default: false,
				},
			],
			total: 2,
		});
		renderPage();

		await screen.findByText("Project One");
		expect(
			screen.queryByRole("button", { name: "Archive Project One" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Archive Project Two" }),
		).toBeVisible();
	});

	it("keeps a failed deletion error inside the open modal", async () => {
		const project = { ...PROJECT, is_default: false };
		api.listProjects.mockResolvedValue({ items: [project], total: 1 });
		api.deleteProject.mockRejectedValue(
			Object.assign(
				new Error("Confirmation name does not match this project"),
				{
					status: 409,
					code: "CONFLICT",
				},
			),
		);
		renderPage();
		await screen.findByText("Project One");

		fireEvent.click(screen.getByRole("button", { name: "Delete Project One" }));
		const dialog = screen.getByRole("dialog", { name: "Delete Project One?" });
		fireEvent.change(
			within(dialog).getByLabelText("Project deletion confirmation"),
			{
				target: { value: "Project One" },
			},
		);
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Delete project" }),
		);

		const alert = await screen.findByText(
			"Confirmation name does not match this project",
		);
		expect(alert).toHaveAttribute("role", "alert");
		expect(dialog).toContainElement(alert);
		expect(screen.getAllByRole("alert")).toHaveLength(1);
	});

	it("does not expose legacy subject-member controls", async () => {
		renderPage();

		await screen.findByText("Project One");
		expect(screen.queryByRole("button", { name: /Manage members/ })).toBeNull();
		expect(screen.queryByLabelText("Member actor")).toBeNull();
	});
});
