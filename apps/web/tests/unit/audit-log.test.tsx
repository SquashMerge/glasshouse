import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listAuditEvents: vi.fn() }));
vi.mock("../../src/lib/api", () => api);

import { AuditLogPage } from "../../src/routes/audit-log";

const event = {
	id: "event-1",
	source: "project_authorization",
	actor: "alice",
	action: "project_updated",
	resource_type: "project",
	resource_id: "project-1",
	outcome: "success",
	created_at: "2026-11-01T12:00:00.000Z",
	details: { source: "project_authorization" },
};

function renderPage() {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<AuditLogPage />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	api.listAuditEvents.mockResolvedValue({
		items: [event],
		next_cursor: "next",
	});
	globalThis.IntersectionObserver = class {
		observe() {}
		disconnect() {}
		unobserve() {}
		takeRecords() {
			return [];
		}
		root = null;
		rootMargin = "";
		thresholds = [];
	} as unknown as typeof IntersectionObserver;
});

it("renders safe audit fields, filters, and a keyboard load-more control", async () => {
	renderPage();
	expect(
		await screen.findByRole("heading", { name: "Audit log" }),
	).toBeVisible();
	expect(await screen.findByText("alice")).toBeVisible();
	expect(screen.getByText("project_updated")).toBeVisible();
	expect(screen.getByText(/project-1/)).toBeVisible();
	expect(
		screen.getByRole("button", { name: "Load more audit events" }),
	).toBeVisible();
	fireEvent.change(screen.getByLabelText("Actor"), {
		target: { value: "alice" },
	});
	expect(await screen.findByText("Safe details")).toBeVisible();
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(api.listAuditEvents).toHaveBeenLastCalledWith(
		expect.objectContaining({ actor: "alice" }),
	);
});

it("offers an explicit retry state", async () => {
	api.listAuditEvents.mockRejectedValueOnce(new Error("offline"));
	renderPage();
	expect(await screen.findByRole("alert")).toHaveTextContent("offline");
	expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
	expect(
		screen.queryByText("No retained audit events are available."),
	).not.toBeInTheDocument();
});

it("shows the empty state after a successful empty response", async () => {
	api.listAuditEvents.mockResolvedValueOnce({ items: [] });
	renderPage();
	expect(
		await screen.findByText("No retained audit events are available."),
	).toBeVisible();
});

it("explains reversed local date filters and submits only after correction", async () => {
	renderPage();
	expect(await screen.findByText("alice")).toBeVisible();
	const from = screen.getByLabelText("From");
	const to = screen.getByLabelText("To");
	const calls = api.listAuditEvents.mock.calls.length;
	fireEvent.change(from, { target: { value: "2026-11-03T12:00" } });
	fireEvent.change(to, { target: { value: "2026-11-02T12:00" } });
	expect(screen.queryByText("alice")).not.toBeInTheDocument();
	expect(screen.getByRole("alert")).toHaveTextContent(
		"The start time must be before the end time.",
	);
	expect(from).toHaveAttribute("aria-invalid", "true");
	expect(to).toHaveAttribute("aria-invalid", "true");
	expect(from).toHaveAccessibleDescription(/start time must be before/);
	expect(to).toHaveAccessibleDescription(/start time must be before/);
	expect(screen.getByText(/local time zone/i)).toBeVisible();
	await new Promise((resolve) => setTimeout(resolve, 350));
	expect(api.listAuditEvents).toHaveBeenCalledTimes(calls);
	fireEvent.change(to, { target: { value: "2026-11-04T12:00" } });
	await new Promise((resolve) => setTimeout(resolve, 350));
	expect(api.listAuditEvents).toHaveBeenCalledTimes(calls + 1);
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
