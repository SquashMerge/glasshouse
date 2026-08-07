import { describe, expect, it, mock } from "bun:test";

const query = mock(async () => ({
	json: async () => [
		{ trace_id: "trace-1", physical_rows: "1" },
		{ trace_id: "trace-2", physical_rows: "1" },
	],
}));
const command = mock(async () => undefined);

mock.module("../../src/db/clickhouse", () => ({
	ch: () => ({ query, command }),
}));

const {
	deleteSafeDatasetRetentionBatch,
	deleteTraceObservations,
	deleteTraces,
	failInterruptedRetentionRuns,
	selectTraceRetentionBatch,
} = await import("../../src/db/governance");

describe("governance retention", () => {
	it("selects only wholly expired bounded trace groups and preserves post-cutoff rows", async () => {
		expect(
			await selectTraceRetentionBatch(
				"organization",
				"project",
				new Date("2026-01-01T00:00:00Z"),
				2,
			),
		).toEqual({ traceIds: ["trace-1", "trace-2"], physicalUnits: 2 });
		expect(query.mock.calls[0]?.[0]).toMatchObject({
			query: expect.stringMatching(
				/HAVING newest < \{cutoff:DateTime64\(3\)\} AND physical_rows <= \{batchSize:UInt64\}[\s\S]*cumulative_rows <= \{batchSize:UInt64\}/,
			),
			query_params: expect.objectContaining({ batchSize: 2 }),
		});
		await deleteTraceObservations(
			"organization",
			"project",
			new Date("2026-01-01T00:00:00Z"),
			["trace-1", "trace-2"],
		);
		await deleteTraces(
			"organization",
			"project",
			new Date("2026-01-01T00:00:00Z"),
			["trace-1", "trace-2"],
		);
		expect(command).toHaveBeenCalledTimes(2);
		for (const [request] of command.mock.calls) {
			expect(request.query).toContain("trace_id IN {traceIds:Array(String)}");
			expect(request.query).toContain("start_time < {cutoff:DateTime64(3)}");
			expect(request.query_params.traceIds).toEqual(["trace-1", "trace-2"]);
			expect(request.query_params.cutoff).toBe("2026-01-01T00:00:00.000Z");
		}
	});

	it("terminalizes only expired leases and emits content-free failure evidence", async () => {
		const calls: string[] = [];
		const client = {
			query: async (statement: string) => {
				calls.push(statement);
				return { rows: [{ id: "run", project_id: "project" }] };
			},
			release() {},
		};
		const pool = {
			connect: async () => client,
		};
		expect(await failInterruptedRetentionRuns(pool)).toEqual([
			{ id: "run", project_id: "project" },
		]);
		expect(calls[1]).toContain("lease_expires_at < now()");
		expect(calls[2]).toContain("lock_project_audit_provenance");
		expect(calls[3]).toContain("SET status = 'failed'");
		expect(calls[3]).toContain("FOR UPDATE OF p, r");
		expect(calls[3]).toContain("'retention_failed'");
		expect(calls[3]).not.toContain("p.status = 'active'");
		expect(calls[3]).not.toContain("cursor");
	});

	it("leaves an active lease untouched during startup recovery", async () => {
		const calls: string[] = [];
		await failInterruptedRetentionRuns({
			connect: async () => ({
				query: async (statement: string) => {
					calls.push(statement);
					return { rows: [] };
				},
				release() {},
			}),
		});
		expect(calls[1]).toContain(
			"r.status = 'running' AND r.lease_expires_at < now()",
		);
		expect(calls).toHaveLength(3);
	});

	it("waits for the project lock before terminalizing an expired run", async () => {
		let releaseLock!: () => void;
		const lockHeld = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		let settled = false;
		const recovery = failInterruptedRetentionRuns({
			connect: async () => ({
				query: async (statement: string) => {
					if (statement.startsWith("SELECT lock_project")) await lockHeld;
					return { rows: [] };
				},
				release() {},
			}),
		}).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		releaseLock();
		await recovery;
		expect(settled).toBe(true);
	});

	it("skips datasets whenever linked feedback remains after the bounded feedback cleanup", async () => {
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
		expect(statements[0]).not.toContain("DELETE FROM feedback_reviews");
		expect(statements[0]).toContain(
			"NOT EXISTS (SELECT 1 FROM feedback_reviews f WHERE f.dataset_id = d.id)",
		);
		expect(statements[0]).not.toContain("f.created_at >=");
		expect(statements).toHaveLength(1);
		expect(statements[0]).toContain("NOT EXISTS (SELECT 1 FROM experiments");
		expect(statements[0]).toContain(
			"NOT EXISTS (SELECT 1 FROM benchmark_suites",
		);
	});

	it("reports dependency-blocked datasets when no dataset can be deleted", async () => {
		const result = await deleteSafeDatasetRetentionBatch(
			{ query: async () => ({ rows: [{ id: null, skipped: "3" }] }) },
			"project",
			new Date("2026-01-01T00:00:00Z"),
			10,
		);
		expect(result).toEqual({ deleted: 0, skipped: 3 });
	});
});
