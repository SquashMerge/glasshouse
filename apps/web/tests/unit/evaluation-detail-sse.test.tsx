import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const sse = vi.hoisted(() => ({
	onMessage: vi.fn(),
	calls: [] as unknown[][],
}));
const {
	cancelExperiment,
	experimentResults,
	experimentSummary,
	getExperiment,
} = vi.hoisted(() => ({
	cancelExperiment: vi.fn(),
	experimentResults: vi.fn(),
	experimentSummary: vi.fn(),
	getExperiment: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	useParams: () => ({ id: "33333333-3333-4333-8333-333333333333" }),
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({
		selectedProjectId: "11111111-1111-4111-8111-111111111111",
	}),
}));
vi.mock("../../src/lib/api", () => ({
	cancelExperiment,
	experimentResults,
	experimentSummary,
	getExperiment,
	experimentEventsUrl: ({ id }: { id: string }) =>
		`/v1/experiments/${id}/events`,
}));
vi.mock("../../src/hooks/useEventSource", () => ({
	useEventSource: (...args: unknown[]) => {
		sse.calls.push(args);
		const options = args[1] as { onMessage: (message: unknown) => void };
		sse.onMessage.mockImplementation(options.onMessage);
		return { status: "open" };
	},
}));

import { EvaluationDetailPage } from "../../src/routes/evaluations";

const experiment = {
	id: "33333333-3333-4333-8333-333333333333",
	project_id: "11111111-1111-4111-8111-111111111111",
	dataset_id: "22222222-2222-4222-8222-222222222222",
	name: "Smoke",
	status: "running" as const,
	config: {},
	created_at: "2026-07-29T00:00:00.000Z",
	updated_at: "2026-07-29T00:00:00.000Z",
};

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
	sse.calls.length = 0;
});

describe("evaluation detail lifecycle stream", () => {
	it("uses experiment SSE, renders the server summary, and stops live activity on completion", async () => {
		getExperiment.mockResolvedValue(experiment);
		experimentResults.mockResolvedValue({ items: [] });
		experimentSummary.mockResolvedValue({
			experiment_id: experiment.id,
			total: 4,
			passed: 3,
			failed: 1,
			pass_rate: 0.75,
			avg_duration_ms: 42,
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<EvaluationDetailPage />
			</QueryClientProvider>,
		);

		expect(await screen.findByText("3 / 4 passed (75%)")).toBeTruthy();
		expect(sse.calls[0]?.[0]).toBe(`/v1/experiments/${experiment.id}/events`);
		await act(async () => {
			sse.onMessage({
				event: "experiment",
				data: { ...experiment, status: "completed" },
			});
		});
		await waitFor(() =>
			expect((sse.calls.at(-1)?.[1] as { enabled: boolean }).enabled).toBe(
				false,
			),
		);
	});
});
