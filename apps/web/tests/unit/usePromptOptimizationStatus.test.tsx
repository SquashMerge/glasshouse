import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { usePromptOptimizationStatus } from "../../src/hooks/usePromptOptimizationStatus";
import type { OptimizationJob } from "../../src/lib/api";

const { getLatestPromptOptimization, getPromptOptimization } = vi.hoisted(
	() => ({
		getLatestPromptOptimization: vi.fn(),
		getPromptOptimization: vi.fn(),
	}),
);

vi.mock("../../src/lib/api", () => ({
	getLatestPromptOptimization,
	getPromptOptimization,
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function job(id: string, status: OptimizationJob["status"]): OptimizationJob {
	return {
		id,
		status,
		result_version: status === "completed" ? 4 : null,
		error_message: null,
		metric_calls_used: status === "completed" ? 3 : null,
		source_version: 3,
		target: "system",
		budget: { max_metric_calls: 5 },
		created_at: "2026-07-15T10:00:00.000Z",
		updated_at: "2026-07-15T10:01:00.000Z",
		completed_at: status === "completed" ? "2026-07-15T10:02:00.000Z" : null,
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("usePromptOptimizationStatus", () => {
	beforeEach(() => {
		getLatestPromptOptimization.mockReset();
		getPromptOptimization.mockReset();
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("finds a missed terminal event through bounded active snapshot polling", async () => {
		vi.useFakeTimers();
		const active = job("22222222-2222-4222-8222-222222222222", "optimizing");
		const completed = job(active.id, "completed");
		getLatestPromptOptimization.mockResolvedValue(active);
		getPromptOptimization.mockResolvedValue(completed);
		const { result } = renderHook(() =>
			usePromptOptimizationStatus({
				projectId: PROJECT_ID,
				slug: "daily-summary",
			}),
		);

		await act(async () => {
			await flush();
		});
		expect(result.current.job?.status).toBe("optimizing");
		await act(async () => {
			vi.advanceTimersByTime(5_000);
			await flush();
		});
		expect(result.current.job).toMatchObject({
			status: "completed",
			metric_calls_used: 3,
		});
	});

	it("runs one follow-up snapshot after a delayed request cannot prove the latest event", async () => {
		const active = job("22222222-2222-4222-8222-222222222222", "optimizing");
		const completed = job(active.id, "completed");
		const delayed = deferred<OptimizationJob>();
		getLatestPromptOptimization.mockResolvedValue(active);
		getPromptOptimization
			.mockImplementationOnce(() => delayed.promise)
			.mockResolvedValueOnce(completed);
		const { result } = renderHook(() =>
			usePromptOptimizationStatus({
				projectId: PROJECT_ID,
				slug: "daily-summary",
			}),
		);

		await act(async () => {
			await flush();
		});
		act(() => {
			void result.current.reconcile();
			void result.current.reconcile();
		});
		delayed.resolve(active);
		await act(async () => {
			await flush();
		});
		expect(getPromptOptimization).toHaveBeenCalledTimes(2);
		expect(result.current.job?.status).toBe("completed");
	});

	it("turns a hung authoritative snapshot into a retryable error", async () => {
		vi.useFakeTimers();
		const active = job("22222222-2222-4222-8222-222222222222", "optimizing");
		getLatestPromptOptimization.mockResolvedValue(active);
		getPromptOptimization.mockImplementation(
			({ signal }: { signal: AbortSignal }) =>
				new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const { result } = renderHook(() =>
			usePromptOptimizationStatus({
				projectId: PROJECT_ID,
				slug: "daily-summary",
			}),
		);

		await act(async () => {
			await flush();
		});
		act(() => {
			void result.current.reconcile();
		});
		await act(async () => {
			vi.advanceTimersByTime(4_000);
			await flush();
		});
		expect(result.current.snapshotError).toBe(
			"Optimization status request timed out.",
		);
	});

	it("drops a late snapshot from a prior prompt identity", async () => {
		const delayed = deferred<OptimizationJob | null>();
		const fresh = job("33333333-3333-4333-8333-333333333333", "completed");
		getLatestPromptOptimization
			.mockImplementationOnce(() => delayed.promise)
			.mockResolvedValueOnce(fresh);
		const { result, rerender } = renderHook(
			({ slug }: { slug: string }) =>
				usePromptOptimizationStatus({ projectId: PROJECT_ID, slug }),
			{ initialProps: { slug: "first" } },
		);

		rerender({ slug: "second" });
		await act(async () => {
			await flush();
		});
		delayed.resolve(job("22222222-2222-4222-8222-222222222222", "optimizing"));
		await act(async () => {
			await flush();
		});
		expect(result.current.job).toMatchObject({
			id: fresh.id,
			status: "completed",
		});
	});
});
