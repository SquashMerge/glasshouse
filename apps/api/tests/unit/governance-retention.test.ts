import { describe, expect, it, mock } from "bun:test";

const query = mock(async () => ({
	json: async () => [{ trace_id: "trace-1" }, { trace_id: "trace-2" }],
}));
const command = mock(async () => undefined);

mock.module("../../src/db/clickhouse", () => ({
	ch: () => ({ query, command }),
}));

const {
	deleteSafeDatasetRetentionBatch,
	deleteTraceRetentionBatch,
	failInterruptedRetentionRuns,
} = await import("../../src/db/governance");

describe("governance retention", () => {
	it("selects a bounded trace batch and deletes only its observations and traces", async () => {
		expect(
			await deleteTraceRetentionBatch(
				"organization",
				"project",
				new Date("2026-01-01T00:00:00Z"),
				2,
			),
		).toBe(2);
		expect(query.mock.calls[0]?.[0]).toMatchObject({
			query: expect.stringContaining("LIMIT {batchSize:UInt64}"),
			query_params: expect.objectContaining({ batchSize: 2 }),
		});
		expect(command).toHaveBeenCalledTimes(2);
		for (const [request] of command.mock.calls) {
			expect(request.query).toContain("trace_id IN {traceIds:Array(String)}");
			expect(request.query_params.traceIds).toEqual(["trace-1", "trace-2"]);
		}
	});

	it("terminalizes abandoned runs and emits content-free failure evidence", async () => {
		const calls: string[] = [];
		const pool = {
			query: async (statement: string) => {
				calls.push(statement);
				return { rows: [{ id: "run", project_id: "project" }] };
			},
		};
		expect(await failInterruptedRetentionRuns(pool)).toEqual([
			{ id: "run", project_id: "project" },
		]);
		expect(calls[0]).toContain("SET status = 'failed'");
		expect(calls[0]).toContain("'retention_failed'");
		expect(calls[0]).not.toContain("cursor");
	});

	it("deletes governed feedback before eligible datasets and skips non-governed dependencies", async () => {
		const statements: string[] = [];
		const result = await deleteSafeDatasetRetentionBatch(
			{
				query: async (statement: string) => {
					statements.push(statement);
					return { rows: [{ id: "dataset", skipped: "2" }] };
				},
			},
			"project",
			new Date("2026-01-01T00:00:00Z"),
			10,
		);
		expect(result).toEqual({ deleted: 1, skipped: 2 });
		expect(statements[0]).toContain("DELETE FROM feedback_reviews");
		expect(statements[0]).toContain("NOT EXISTS (SELECT 1 FROM experiments");
		expect(statements[0]).toContain(
			"NOT EXISTS (SELECT 1 FROM benchmark_suites",
		);
	});
});
