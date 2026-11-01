import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getCurrentActor: vi.fn(),
	listInternalLogs: vi.fn(),
}));
vi.mock("../../src/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api")>()),
	...api,
}));

import { InternalLogsPage } from "../../src/routes/internal-logs";
import { ApiError } from "../../src/lib/api";

const first = {
	id: "11111111-1111-4111-8111-111111111111",
	recorded_at: "2026-11-01T00:01:00.000Z",
	severity: "warn" as const,
	source: "api",
	message: "HTTP GET /v1/projects",
	context: { status: 403 },
};

describe("InternalLogsPage", () => {
	beforeEach(() => {
		api.getCurrentActor.mockReset();
		api.listInternalLogs.mockReset();
		api.getCurrentActor.mockResolvedValue({ organization_role: "admin" });
		api.listInternalLogs
			.mockResolvedValueOnce({
				items: [first],
				total: 2,
				next_cursor: "next",
				sources: ["api"],
				retention_days: 14,
			})
			.mockResolvedValueOnce({
				items: [
					{
						...first,
						id: "22222222-2222-4222-8222-222222222222",
						severity: "error" as const,
					},
				],
				total: 2,
				sources: ["api"],
				retention_days: 14,
			});
		globalThis.IntersectionObserver = class {
			observe() {}
			disconnect() {}
			unobserve() {}
		} as unknown as typeof IntersectionObserver;
	});

	afterEach(() => vi.restoreAllMocks());

	function renderPage() {
		return render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<InternalLogsPage />
			</QueryClientProvider>,
		);
	}

	it("appends keyset pages, exposes keyboard load more, and shows safe context", async () => {
		renderPage();
		expect(await screen.findByText("HTTP GET /v1/projects")).toBeVisible();
		expect(
			screen.getByRole("columnheader", { name: "Time (local)" }),
		).toBeVisible();
		expect(screen.getByText("Local time")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Load more logs" }));
		await waitFor(() => expect(api.listInternalLogs).toHaveBeenCalledTimes(2));
		expect(await screen.findByText("End of retained results.")).toBeVisible();
		fireEvent.click(screen.getByLabelText(`Open log entry ${first.id}`));
		expect(
			await screen.findByRole("dialog", { name: "Safe log context" }),
		).toBeVisible();
		expect(
			screen.getByText(
				(_, element) =>
					element?.tagName === "PRE" &&
					element.textContent?.includes('"status": 403') === true,
			),
		).toBeVisible();
	});

	it("restarts from a fresh filtered query and does not expose the page to non-Admins", async () => {
		renderPage();
		await screen.findByText("HTTP GET /v1/projects");
		fireEvent.change(screen.getByLabelText("Search"), {
			target: { value: "projects" },
		});
		await waitFor(() =>
			expect(api.listInternalLogs).toHaveBeenLastCalledWith(
				expect.objectContaining({ q: "projects", cursor: undefined }),
			),
		);

		api.getCurrentActor.mockResolvedValueOnce({
			organization_role: "read_only",
		});
		renderPage();
		expect(
			await screen.findByText("Logs are restricted to Organization Admins."),
		).toBeVisible();
	});

	it("offers retry when access status fails instead of claiming access is restricted", async () => {
		api.getCurrentActor.mockRejectedValueOnce(new Error("network"));
		renderPage();
		expect(
			await screen.findByText("Access status could not be loaded."),
		).toBeVisible();
		expect(
			screen.queryByText("Logs are restricted to Organization Admins."),
		).not.toBeInTheDocument();
		expect(api.listInternalLogs).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("HTTP GET /v1/projects")).toBeVisible();
	});

	it("offers retry when logs fail without showing a misleading empty state", async () => {
		api.listInternalLogs.mockReset();
		api.listInternalLogs.mockRejectedValueOnce(
			new ApiError(500, "INTERNAL", "Could not load internal logs"),
		);
		api.listInternalLogs.mockResolvedValueOnce({
			items: [first],
			total: 1,
			sources: ["api"],
			retention_days: 14,
		});
		renderPage();
		expect(
			await screen.findByText("Failed to load: Could not load internal logs"),
		).toBeVisible();
		expect(
			screen.queryByText(/No retained API operational logs/),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/No logs match/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Scroll to load more/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("HTTP GET /v1/projects")).toBeVisible();
	});

	it("explains an invalid level rather than silently showing unfiltered logs", async () => {
		renderPage();
		await screen.findByText("HTTP GET /v1/projects");
		const callsBeforeInvalidFilter = api.listInternalLogs.mock.calls.length;
		vi.useFakeTimers();
		try {
			fireEvent.change(screen.getByLabelText("Level"), {
				target: { value: "bogus" },
			});
			expect(
				screen.getByText(/Enter debug, info, warn, or error/),
			).toBeVisible();
			expect(screen.getByLabelText("Level")).toHaveAttribute(
				"aria-invalid",
				"true",
			);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(300);
			});
			expect(api.listInternalLogs).toHaveBeenCalledTimes(
				callsBeforeInvalidFilter,
			);
		} finally {
			vi.useRealTimers();
		}
		fireEvent.change(screen.getByLabelText("Level"), {
			target: { value: "warn" },
		});
		await waitFor(() =>
			expect(api.listInternalLogs).toHaveBeenLastCalledWith(
				expect.objectContaining({ level: "warn", cursor: undefined }),
			),
		);
		expect(
			screen.queryByText(/Enter debug, info, warn, or error/),
		).not.toBeInTheDocument();
	});

	it("explains a disabled source and offers a retry", async () => {
		api.listInternalLogs.mockReset();
		api.listInternalLogs.mockRejectedValueOnce(
			new ApiError(
				503,
				"SERVICE_UNAVAILABLE",
				"Internal log collection is unavailable on this deployment",
			),
		);
		renderPage();
		expect(await screen.findByText("Log source unavailable")).toBeVisible();
		expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
	});
});
