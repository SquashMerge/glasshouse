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
	deleteProject: vi.fn(),
	getProjectDeletionStatus: vi.fn(),
	setDefaultProject: vi.fn(),
	listProjectMembers: vi.fn(),
	putProjectMember: vi.fn(),
	deleteProjectMember: vi.fn(),
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

	it("lets owners create, edit slug, archive, and restore persisted projects", async () => {
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
		api.listProjectMembers.mockResolvedValue({ items: [] });
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
		fireEvent.change(screen.getByLabelText("New slug for Project One"), {
			target: { value: "renamed-project" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save name" }));
		await waitFor(() =>
			expect(api.updateProject.mock.calls[0]?.[0]).toEqual({
				id: PROJECT.id,
				name: "Renamed",
				slug: "renamed-project",
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "Archive Renamed" }));
		await waitFor(() =>
			expect(api.archiveProject.mock.calls[0]?.[0]).toBe(PROJECT.id),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Restore Project One" }),
		);
		await waitFor(() =>
			expect(api.restoreProject.mock.calls[0]?.[0]).toBe(PROJECT.id),
		);
	});

	it("lets owners set another active project as the default", async () => {
		const otherProject = {
			...PROJECT,
			id: "22222222-2222-4222-8222-222222222222",
			name: "Project Two",
			slug: "project-two",
			is_default: false,
		};
		api.listProjects.mockResolvedValue({
			items: [PROJECT, otherProject],
			total: 2,
		});
		api.setDefaultProject.mockResolvedValue({
			...otherProject,
			is_default: true,
		});
		renderPage();

		await screen.findByText("Project Two");
		fireEvent.click(screen.getByRole("button", { name: "Set as default" }));
		await waitFor(() =>
			expect(api.setDefaultProject.mock.calls[0]?.[0]).toBe(otherProject.id),
		);
	});

	it("keeps the default badge and hides Delete after replacing the renamed project", async () => {
		api.updateProject.mockResolvedValue({
			...PROJECT,
			name: "Renamed",
			slug: "renamed-project",
			is_default: true,
		});
		renderPage();

		await screen.findByText("Project One");
		fireEvent.click(screen.getByRole("button", { name: "Rename Project One" }));
		fireEvent.change(screen.getByLabelText("New name for Project One"), {
			target: { value: "Renamed" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save name" }));

		await screen.findByText("Renamed");
		expect(screen.getByText("Default")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Delete Renamed" })).toBeNull();
	});

	it("loads persisted archived projects and manages members for managers", async () => {
		api.listProjects.mockResolvedValue({
			items: [
				PROJECT,
				{
					...PROJECT,
					id: "22222222-2222-4222-8222-222222222222",
					name: "Archived Project",
					status: "archived",
					archived_at: "2026-07-16T10:00:00.000Z",
				},
			],
			total: 2,
		});
		api.listProjectMembers.mockResolvedValue({
			items: [
				{
					actor_subject: "member",
					role: "read_only",
					created_at: PROJECT.created_at,
				},
			],
		});
		api.putProjectMember.mockResolvedValue({
			actor_subject: "new-member",
			role: "user",
			created_at: PROJECT.created_at,
		});
		api.deleteProjectMember.mockResolvedValue(undefined);
		renderPage();

		await screen.findByText("Archived Project");
		fireEvent.click(
			screen.getByRole("button", { name: "Manage members for Project One" }),
		);
		await screen.findByRole("button", { name: "Remove member" });
		fireEvent.change(screen.getByLabelText("Member actor"), {
			target: { value: "new-member" },
		});
		fireEvent.change(screen.getByLabelText("Member role"), {
			target: { value: "user" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add member" }));
		await waitFor(() =>
			expect(api.putProjectMember.mock.calls[0]?.[0]).toEqual({
				projectId: PROJECT.id,
				actorSubject: "new-member",
				role: "user",
			}),
		);
		fireEvent.change(screen.getByLabelText("Role for member"), {
			target: { value: "user" },
		});
		await waitFor(() =>
			expect(api.putProjectMember.mock.calls[1]?.[0]).toEqual({
				projectId: PROJECT.id,
				actorSubject: "member",
				role: "user",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove member" }));
		await waitFor(() =>
			expect(api.deleteProjectMember.mock.calls[0]?.[0]).toEqual({
				projectId: PROJECT.id,
				actorSubject: "member",
			}),
		);
	});

	it("hides management controls from ordinary project members", async () => {
		api.listProjects.mockResolvedValue({
			items: [{ ...PROJECT, project_role: "read_only" }],
			total: 1,
		});
		renderPage();

		await screen.findByText("Project One");
		expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /Archive/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /Manage members/ })).toBeNull();
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

	it("shows a failed deletion after reload and retries only after exact confirmation", async () => {
		const deletingProject = {
			...PROJECT,
			status: "deleting" as const,
			is_default: false,
		};
		api.listProjects.mockResolvedValue({
			items: [deletingProject],
			total: 1,
		});
		api.getProjectDeletionStatus.mockResolvedValue({
			status: "failed",
			traces_cleaned_at: null,
			observations_cleaned_at: null,
			completed_at: null,
			attempt_count: 1,
		});
		api.deleteProject.mockRejectedValue(new Error("internal details"));
		renderPage();

		await screen.findByText("Deletion recovery");
		await screen.findByText("Deletion failed");
		const retry = screen.getByRole("button", { name: "Retry deletion" });
		expect(retry).toBeDisabled();
		fireEvent.change(
			screen.getByLabelText("Deletion confirmation for Project One"),
			{ target: { value: "Project One" } },
		);
		fireEvent.click(retry);
		await waitFor(() =>
			expect(api.deleteProject.mock.calls[0]?.[0]).toEqual({
				id: PROJECT.id,
				confirmation_name: "Project One",
			}),
		);
		await screen.findByRole("alert");
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Project operation could not be completed.",
		);
		expect(screen.getByRole("alert")).not.toHaveTextContent("internal details");
	});
});
