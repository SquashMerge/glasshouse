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
});
