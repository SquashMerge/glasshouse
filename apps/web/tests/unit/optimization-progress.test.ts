import { describe, expect, it } from "vitest";
import {
	optimizationDiff,
	parseOptimizationEvent,
	progressScore,
} from "../../src/lib/optimization-progress";

const job = {
	id: "22222222-2222-4222-8222-222222222222",
	status: "completed" as const,
	result_version: 4,
	error_message: null,
	metric_calls_used: null,
	source_version: 3,
	target: "system" as const,
	budget: { max_metric_calls: 20 },
};

describe("optimization progress", () => {
	it("parses safe status events and retains optional score fields", () => {
		const event = parseOptimizationEvent({
			id: 7,
			status: "evaluating",
			detail: { score: 0.875 },
			created_at: "2026-07-15T10:00:01.000Z",
		});

		expect(event?.status).toBe("evaluating");
		expect(progressScore(event ?? null)).toBe(0.875);
		expect(progressScore(null)).toBeNull();
		expect(parseOptimizationEvent({ status: "optimizing" })).toBeNull();
	});

	it("derives a completion summary and before/after role diff from versions", () => {
		expect(
			optimizationDiff(job, [
				{
					id: "support-agent",
					version: 3,
					messages: [{ role: "system", content: "Be concise\nCite sources" }],
					model: null,
					settings: {},
					change_summary: "Source",
					created_by: "admin",
					created_by_username: "admin",
					created_at: "2026-07-15T10:00:00.000Z",
					content_hash: "a".repeat(64),
					diff: null,
				},
				{
					id: "support-agent",
					version: 4,
					messages: [
						{ role: "system", content: "Be concise\nCite reliable sources" },
					],
					model: null,
					settings: {},
					change_summary: "GEPA optimization",
					created_by: "admin",
					created_by_username: "admin",
					created_at: "2026-07-15T10:01:00.000Z",
					content_hash: "b".repeat(64),
					diff: null,
				},
			]),
		).toEqual({
			summary: "Candidate differs from source v3.",
			before: "Be concise\nCite sources",
			after: "Be concise\nCite reliable sources",
		});
	});

	it("does not fabricate a diff when completion metadata is absent", () => {
		expect(optimizationDiff({ ...job, result_version: null }, [])).toBeNull();
	});
});
