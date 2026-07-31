import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { listTraces } = vi.hoisted(() => ({ listTraces: vi.fn() }));

vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({ selectedProjectId: "project-1" }),
}));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
		"@tanstack/react-router",
	);
	return {
		...actual,
		useLocation: () => ({ searchStr: "" }),
		useNavigate: () => vi.fn(),
	};
});

vi.mock("../../src/hooks/useEventSource", () => ({
	useEventSource: () => ({
		status: "open" as const,
		paused: false,
		lastEventAt: null,
		debug: {
			framesReceived: 0,
			bufferDepth: 0,
			reconnectAttempts: 0,
			lastError: null,
		},
		reconnect: vi.fn(),
	}),
}));

vi.mock("../../src/lib/api", async () => {
	const actual =
		await vi.importActual<typeof import("../../src/lib/api")>(
			"../../src/lib/api",
		);
	return { ...actual, listTraces };
});

import { ApiError } from "../../src/lib/api";
import { TracesTab } from "../../src/routes/observability";

function renderTraces() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
	});
	return render(
		<QueryClientProvider client={client}>
			<TracesTab />
		</QueryClientProvider>,
	);
}

describe("TracesTab empty and failure states", () => {
	beforeEach(() => {
		listTraces.mockReset();
	});

	afterEach(() => cleanup());

	it("renders the onboarding state without an error or Retry for an empty project", async () => {
		listTraces.mockResolvedValue({ items: [], total: 0 });

		renderTraces();

		expect(await screen.findByText(/No traces yet/)).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Retry" }),
		).not.toBeInTheDocument();
	});

	it("renders the no-match state without an error or Retry for an empty filtered result", async () => {
		listTraces.mockResolvedValue({ items: [], total: 0 });

		renderTraces();
		await screen.findByText(/No traces yet/);
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "missing" },
		});

		expect(
			await screen.findByText("No traces match the current filters."),
		).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Retry" }),
		).not.toBeInTheDocument();
	});

	it("shows a Retry control for a true listTraces HTTP 500", async () => {
		listTraces.mockRejectedValue(
			new ApiError(500, "INTERNAL", "Query failed; check server logs"),
		);

		renderTraces();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Failed to load: Query failed; check server logs",
		);
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
	});

	it("does not offer Retry for a non-500 listTraces response", async () => {
		listTraces.mockRejectedValue(
			new ApiError(400, "BAD_REQUEST", "Request validation failed"),
		);

		renderTraces();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Failed to load: Request validation failed",
		);
		expect(
			screen.queryByRole("button", { name: "Retry" }),
		).not.toBeInTheDocument();
		await waitFor(() => expect(listTraces).toHaveBeenCalled());
	});
});
