import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getCurrentActor: vi.fn(),
	listAdminActors: vi.fn(),
	listLocalAccounts: vi.fn(),
	listProjects: vi.fn(),
	listProjectGrants: vi.fn(),
	setAdminActorRole: vi.fn(),
	setProjectGrant: vi.fn(),
	revokeProjectGrant: vi.fn(),
	recoverAdmin: vi.fn(),
}));

vi.mock("../../src/lib/api", () => api);

import { AdminAccessPage } from "../../src/routes/admin-access";

const CURRENT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const UNRESOLVED_ACTOR_ID = "33333333-3333-4333-8333-333333333333";

function renderPage() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<AdminAccessPage />
		</QueryClientProvider>,
	);
}

describe("AdminAccessPage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.getCurrentActor.mockResolvedValue({
			actor_id: CURRENT_ACTOR_ID,
			actor_subject: "owner",
			organization_role: "admin",
			can_recover_admin: true,
		});
		api.listAdminActors.mockResolvedValue({
			items: [
				{
					actor_id: CURRENT_ACTOR_ID,
					organization_role: "admin",
					created_at: "2026-08-13T00:00:00.000Z",
				},
				{
					actor_id: UNRESOLVED_ACTOR_ID,
					organization_role: "read_only",
					created_at: "2026-08-14T00:00:00.000Z",
				},
			],
		});
		api.listProjects.mockResolvedValue({
			items: [
				{
					id: "22222222-2222-4222-8222-222222222222",
					name: "Active Project",
					status: "active",
				},
			],
		});
		api.listProjectGrants.mockResolvedValue({ items: [] });
		api.listLocalAccounts.mockResolvedValue({ items: [] });
	});

	it("shows accessible Admin role controls and an empty grant state", async () => {
		renderPage();

		expect(
			await screen.findByRole("heading", { name: "Access" }),
		).toBeVisible();
		expect(screen.getByLabelText("Role for owner")).toHaveValue("admin");
		expect(
			await screen.findByText("No explicit grants for this Project."),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Recover Admin access" }),
		).toBeVisible();
	});

	it("shows the authenticated subject and accessible compact fallbacks", async () => {
		api.listProjectGrants.mockResolvedValue({
			items: [
				{
					actor_id: UNRESOLVED_ACTOR_ID,
					project_id: "22222222-2222-4222-8222-222222222222",
					role: "read_only",
					created_at: "2026-08-14T00:00:00.000Z",
				},
			],
		});
		renderPage();

		expect(await screen.findByText("owner")).toBeVisible();
		const currentActor = screen.getByLabelText("owner, current user");
		expect(currentActor).not.toHaveAttribute("title", CURRENT_ACTOR_ID);
		expect(screen.queryByText(CURRENT_ACTOR_ID)).toBeNull();
		expect(screen.queryByText(UNRESOLVED_ACTOR_ID)).toBeNull();
		await screen.findByRole("button", { name: "Revoke grant" });
		const fallbacks = screen.getAllByLabelText(
			`Actor ID ${UNRESOLVED_ACTOR_ID}`,
		);
		expect(fallbacks).toHaveLength(2);
		for (const fallback of fallbacks) {
			expect(fallback).toHaveTextContent("Actor 33333333");
			expect(fallback).toHaveAttribute("title", UNRESOLVED_ACTOR_ID);
		}
	});

	it("does not leak administration controls to non-Admins", async () => {
		api.getCurrentActor.mockResolvedValue({
			organization_role: "read_only",
			can_recover_admin: false,
		});
		renderPage();

		expect(
			await screen.findByText("Access management is restricted to Admins."),
		).toBeVisible();
		expect(screen.queryByLabelText("Role for owner")).toBeNull();
	});

	it("shows only recovery to the configured bootstrap owner without Admin role", async () => {
		api.getCurrentActor.mockResolvedValue({
			organization_role: "user",
			can_recover_admin: true,
		});
		renderPage();

		expect(
			await screen.findByRole("button", { name: "Recover Admin access" }),
		).toBeVisible();
		expect(screen.queryByLabelText("Role for owner")).toBeNull();
	});
});
