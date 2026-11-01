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

	it("hides loaded logs when a continuation loses Admin access", async () => {
		api.listInternalLogs.mockReset();
		api.listInternalLogs.mockResolvedValueOnce({
			items: [first],
			total: 2,
			next_cursor: "next",
			sources: ["api"],
			retention_days: 14,
		});
		api.listInternalLogs.mockRejectedValueOnce(
			new ApiError(403, "FORBIDDEN", "Admin access required"),
		);
		renderPage();
		await screen.findByText(first.message);
		fireEvent.click(screen.getByRole("button", { name: "Load more logs" }));
		expect(await screen.findByText(/Access changed/)).toBeVisible();
		expect(screen.queryByText(first.message)).not.toBeInTheDocument();
	});

	it("does not silently create a new snapshot when active queries reset", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<InternalLogsPage />
			</QueryClientProvider>,
		);
		await screen.findByText(first.message);
		await act(async () => {
			await client.resetQueries({ queryKey: ["admin", "internal-logs"] });
		});
		expect(api.listInternalLogs).toHaveBeenCalledTimes(1);
		expect(await screen.findByText(/Refresh to restart/)).toBeVisible();
	});

	it("refresh starts a new traversal instead of appending old pages", async () => {
		renderPage();
		await screen.findByText(first.message);
		fireEvent.click(screen.getByRole("button", { name: "Load more logs" }));
		await screen.findByText("End of retained results.");
		api.listInternalLogs.mockResolvedValueOnce({
			items: [{ ...first, message: "Refreshed result" }],
			total: 1,
			sources: ["api"],
			retention_days: 14,
		});
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("Refreshed result")).toBeVisible();
		expect(screen.queryByText(first.message)).not.toBeInTheDocument();
		expect(api.listInternalLogs).toHaveBeenLastCalledWith(
			expect.objectContaining({ cursor: undefined }),
		);
	});

	it("requires a restart after a snapshot is invalidated", async () => {
		api.listInternalLogs.mockReset();
		api.listInternalLogs.mockResolvedValueOnce({
			items: [first],
			total: 2,
			next_cursor: "next",
			sources: ["api"],
			retention_days: 14,
		});
		api.listInternalLogs.mockRejectedValueOnce(
			new ApiError(
				409,
				"CONFLICT",
				"Log results expired or changed. Refresh to restart.",
			),
		);
		api.listInternalLogs.mockResolvedValueOnce({
			items: [{ ...first, message: "New snapshot" }],
			total: 1,
			sources: ["api"],
			retention_days: 14,
		});
		renderPage();
		await screen.findByText(first.message);
		fireEvent.click(screen.getByRole("button", { name: "Load more logs" }));
		expect(await screen.findByText(/Refresh to restart/)).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("New snapshot")).toBeVisible();
		expect(screen.queryByText(first.message)).not.toBeInTheDocument();
	});

	it("stacks the title and counter on narrow screens while retaining the desktop row", async () => {
		renderPage();
		const title = await screen.findByText("Operational logs");
		const header = title.parentElement;
		expect(header).toHaveClass("flex-col", "sm:flex-row");
	});

	it("does not automatically retry a failed next page while the sentinel is visible", async () => {
		api.listInternalLogs.mockReset();
		api.listInternalLogs.mockResolvedValueOnce({
			items: [first],
			total: 2,
			next_cursor: "next",
			sources: ["api"],
			retention_days: 14,
		});
		api.listInternalLogs.mockRejectedValue(new Error("page offline"));
		globalThis.IntersectionObserver = class {
			callback: IntersectionObserverCallback;
			constructor(callback: IntersectionObserverCallback) {
				this.callback = callback;
			}
			active = true;
			observe() {
				setTimeout(() => {
					if (this.active)
						this.callback(
							[{ isIntersecting: true } as IntersectionObserverEntry],
							this as unknown as IntersectionObserver,
						);
				}, 0);
			}
			disconnect() {
				this.active = false;
			}
			unobserve() {}
		} as unknown as typeof IntersectionObserver;
		renderPage();
		expect(
			await screen.findByText("Failed to load: page offline"),
		).toBeVisible();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 200));
		});
		expect(api.listInternalLogs).toHaveBeenCalledTimes(2);
		api.listInternalLogs.mockResolvedValue({
			items: [first],
			total: 1,
			sources: ["api"],
			retention_days: 14,
		});
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(
				screen.queryByText("Failed to load: page offline"),
			).not.toBeInTheDocument(),
		);
		expect(api.listInternalLogs).toHaveBeenLastCalledWith(
			expect.objectContaining({ cursor: "next" }),
		);
	});

	it.each([
		["Level", "warn", "level", "warn"],
		["Source", "api", "source", "api"],
		["Search", "needle", "q", "needle"],
		["Time range", "Last 5 minutes", "time_from", expect.any(String)],
	])(
		"ignores an older response after changing %s",
		async (label, value, key, expected) => {
			let finishOld!: (value: unknown) => void;
			api.listInternalLogs.mockReset();
			api.listInternalLogs.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishOld = resolve;
					}),
			);
			api.listInternalLogs.mockResolvedValue({
				items: [{ ...first, message: "Newest filter result" }],
				total: 1,
				sources: ["api"],
				retention_days: 14,
			});
			renderPage();
			const control = await screen.findByLabelText(label);
			await waitFor(() =>
				expect(api.listInternalLogs).toHaveBeenCalledTimes(1),
			);
			fireEvent.change(control, { target: { value } });
			await screen.findByText("Newest filter result");
			expect(api.listInternalLogs).toHaveBeenLastCalledWith(
				expect.objectContaining({ [key]: expected, cursor: undefined }),
			);
			await act(async () => {
				finishOld({
					items: [first],
					total: 1,
					sources: ["api"],
					retention_days: 14,
				});
			});
			expect(screen.queryByText(first.message)).not.toBeInTheDocument();
			expect(screen.getByText("Newest filter result")).toBeVisible();
		},
	);

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
