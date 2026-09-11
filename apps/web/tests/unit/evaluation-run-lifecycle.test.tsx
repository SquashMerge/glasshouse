import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({
	getEvaluationRunStatus: vi.fn(),
	cancelEvaluationRun: vi.fn(),
	retryEvaluationRun: vi.fn(),
	evaluationRunEventsUrl: vi.fn(() => "/events"),
}));

vi.mock("../../src/lib/api", () => api);
vi.mock("../../src/hooks/useEventSource", () => ({
	useEventSource: () => ({ status: "open" }),
}));

import { EvaluationRunLifecycle } from "../../src/routes/evaluations";

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

describe("Evaluation Run lifecycle evidence", () => {
	it("renders bounded failure, cost, rationale, trace, and cancellation evidence", async () => {
		api.getEvaluationRunStatus.mockResolvedValue({
			id: "11111111-1111-4111-8111-111111111111",
			project_id: "22222222-2222-4222-8222-222222222222",
			status: "failed",
			counts: {
				total: 2,
				pending: 0,
				running: 0,
				completed: 0,
				failed: 1,
				cancelled: 1,
			},
			attempts: 2,
			created_at: "2026-09-10T00:00:00.000Z",
			updated_at: "2026-09-10T00:00:00.000Z",
			terminal_reason: "task_failed",
			items: [
				{
					task_id: "33333333-3333-4333-8333-333333333333",
					item_key: "first",
					position: 0,
					status: "failed",
					attempt_count: 2,
					error_classification: "cost_limit_exceeded",
					error_message: "evaluation cost limit exceeded",
					cost_usd: 1.25,
					evaluator_rationale: { kind: "exact_match", score: 0 },
					trace_id: "trace-1",
				},
				{
					task_id: "44444444-4444-4444-8444-444444444444",
					item_key: "second",
					status: "cancelled",
					position: 1,
					attempt_count: 1,
					error_classification: "cancelled_by_request",
					error_message: "evaluation run cancelled",
					cost_usd: null,
					evaluator_rationale: null,
					trace_id: null,
				},
			],
			items_truncated: false,
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		render(
			<QueryClientProvider client={client}>
				<EvaluationRunLifecycle
					projectId="22222222-2222-4222-8222-222222222222"
					runId="11111111-1111-4111-8111-111111111111"
					canExecute={false}
				/>
			</QueryClientProvider>,
		);

		const evidence = () =>
			document.querySelector('[aria-label="Evaluation Run item evidence"]')
				?.textContent ?? "";
		await screen.findByText("evaluation cost limit exceeded");
		expect(evidence()).toContain("cost_limit_exceeded");
		expect(screen.getByText("$1.25")).toBeTruthy();
		expect(evidence()).toContain("Trace: trace-1");
		expect(screen.getByText(/exact_match/, { selector: "pre" })).toBeTruthy();
		expect(evidence()).toContain("cancelled_by_request");
		expect(evidence()).toContain("evaluation run cancelled");
	});
});
