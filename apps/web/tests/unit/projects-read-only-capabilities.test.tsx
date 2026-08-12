import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
		organizationRole: "user",
		selectProject: vi.fn(),
	}),
}));

import { ProjectsPage } from "../../src/routes/projects";

describe("project dashboard capabilities", () => {
	afterEach(cleanup);

	it("does not render management controls for a Read-only project role", async () => {
		api.listProjects.mockResolvedValue({
			items: [
				{
					id: "11111111-1111-4111-8111-111111111111",
					name: "Evidence",
					slug: "evidence",
					status: "active",
					created_at: "2026-08-11T00:00:00.000Z",
					archived_at: null,
					project_role: "read_only",
					is_default: false,
				},
			],
			total: 1,
		});

		render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<ProjectsPage />
			</QueryClientProvider>,
		);

		await screen.findByText("Evidence");
		expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /Archive/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /Manage members/ })).toBeNull();
	});

	it("shows compatibility-manager controls from server-authoritative capabilities", async () => {
		api.listProjects.mockResolvedValue({
			items: [
				{
					id: "11111111-1111-4111-8111-111111111111",
					name: "Compatibility manager",
					slug: "compatibility-manager",
					status: "active",
					created_at: "2026-08-11T00:00:00.000Z",
					archived_at: null,
					project_role: "user",
					can_manage: true,
					can_govern: true,
					is_default: false,
				},
			],
			total: 1,
		});

		render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<ProjectsPage />
			</QueryClientProvider>,
		);

		await screen.findByText("Compatibility manager");
		expect(
			screen.getByRole("button", { name: "Rename Compatibility manager" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Manage members for Compatibility manager",
			}),
		).toBeInTheDocument();
	});

	it("hides management controls for a strict User from server-authoritative capabilities", async () => {
		api.listProjects.mockResolvedValue({
			items: [
				{
					id: "11111111-1111-4111-8111-111111111111",
					name: "Strict user",
					slug: "strict-user",
					status: "active",
					created_at: "2026-08-11T00:00:00.000Z",
					archived_at: null,
					project_role: "user",
					can_manage: false,
					can_govern: false,
					is_default: false,
				},
			],
			total: 1,
		});

		render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<ProjectsPage />
			</QueryClientProvider>,
		);

		await screen.findByText("Strict user");
		expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /Manage members/ })).toBeNull();
	});
});
