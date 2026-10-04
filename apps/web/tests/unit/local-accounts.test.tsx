import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalAccounts } from "../../src/components/LocalAccounts";
import * as api from "../../src/lib/api";

describe("local account administration", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});
	beforeEach(() => {
		vi.spyOn(api, "listLocalAccounts").mockResolvedValue({ items: [] });
	});
	it("shows a provisioned code only in ephemeral state, focuses it, and discards it on dismissal", async () => {
		const code = {
			actor_id: "test-actor",
			enrollment_id: "test-enrollment",
			code: "test-only-code".padEnd(43, "x"),
		};
		vi.spyOn(api, "provisionLocalAccount").mockResolvedValue(code);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<LocalAccounts />
			</QueryClientProvider>,
		);
		await screen.findByText(/No local accounts/);
		fireEvent.change(screen.getByLabelText("New username"), {
			target: { value: "new.user" },
		});
		fireEvent.submit(
			screen
				.getByRole("button", { name: "Provision account" })
				.closest("form")!,
		);
		const field = await screen.findByLabelText("Enrollment code (shown once)");
		await waitFor(() => expect(field).toHaveFocus());
		expect(field).toHaveValue(code.code);
		expect(
			JSON.stringify(
				client
					.getQueryCache()
					.getAll()
					.map((query) => query.state.data),
			),
		).not.toContain(code.code);
		expect(client.getMutationCache().getAll()).toHaveLength(0);
		fireEvent.click(
			screen.getByRole("button", { name: /handed off the code/ }),
		);
		expect(
			screen.queryByLabelText("Enrollment code (shown once)"),
		).not.toBeInTheDocument();
		for (const storage of [window.localStorage, window.sessionStorage])
			expect(JSON.stringify(storage)).not.toContain(code.code);
	});
	it("shows current roles and expired/revoked/disabled states without code retrieval controls", async () => {
		vi.mocked(api.listLocalAccounts).mockResolvedValue({
			items: [
				{
					actor_id: "test-actor",
					username: "disabled.user",
					organization_role: "read_only",
					status: "disabled",
					project_grants: [],
					enrollments: [
						{
							id: "expired",
							status: "expired",
							created_at: "2026-01-01T00:00:00Z",
							expires_at: "2026-01-08T00:00:00Z",
						},
						{
							id: "revoked",
							status: "revoked",
							created_at: "2026-01-01T00:00:00Z",
							expires_at: "2026-01-08T00:00:00Z",
						},
					],
				},
			],
		});
		render(
			<QueryClientProvider client={new QueryClient()}>
				<LocalAccounts />
			</QueryClientProvider>,
		);
		expect(await screen.findByLabelText("Role for disabled.user")).toHaveValue(
			"read_only",
		);
		expect(screen.getByText(/^expired/)).toBeVisible();
		expect(screen.getByText(/^revoked/)).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Re-enroll disabled.user" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Enable disabled.user" }),
		).toBeEnabled();
		expect(
			screen.queryByLabelText("Enrollment code (shown once)"),
		).not.toBeInTheDocument();
	});
});
