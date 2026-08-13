import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getCurrentActor: vi.fn(),
	listAdminActors: vi.fn(),
	listProjects: vi.fn(),
	listProjectGrants: vi.fn(),
	setAdminActorRole: vi.fn(),
	setProjectGrant: vi.fn(),
	revokeProjectGrant: vi.fn(),
	recoverAdmin: vi.fn(),
}));

vi.mock("../../src/lib/api", () => api);

import { AdminAccessPage } from "../../src/routes/admin-access";

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
			organization_role: "admin",
			can_recover_admin: true,
		});
		api.listAdminActors.mockResolvedValue({
			items: [
				{
					actor_id: "11111111-1111-4111-8111-111111111111",
					organization_role: "admin",
					created_at: "2026-08-13T00:00:00.000Z",
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
	});

	it("shows accessible Admin role controls and an empty grant state", async () => {
		renderPage();

		expect(
			await screen.findByRole("heading", { name: "Access" }),
		).toBeVisible();
		expect(screen.getByLabelText("Role for actor 11111111")).toHaveValue(
			"admin",
		);
		expect(
			await screen.findByText("No explicit grants for this Project."),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Recover Admin access" }),
		).toBeVisible();
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
		expect(screen.queryByLabelText("Role for actor 11111111")).toBeNull();
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
		expect(screen.queryByLabelText("Role for actor 11111111")).toBeNull();
	});
});
