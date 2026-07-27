import { describe, expect, it } from "bun:test";
import { nextOptimizationEvents } from "../../src/routes/prompt-optimizations";

describe("optimization event streaming", () => {
	it("deduplicates replayed events and closes after the first terminal batch", () => {
		const result = nextOptimizationEvents(
			[
				{
					id: 1,
					status: "queued",
					detail: {},
					created_at: "2026-07-15T10:00:00.000Z",
				},
				{
					id: 2,
					status: "completed",
					detail: { result_version: 4 },
					created_at: "2026-07-15T10:00:01.000Z",
				},
			],
			1,
		);

		expect(result.events.map((event) => event.id)).toEqual([2]);
		expect(result.lastId).toBe(2);
		expect(result.terminal).toBe(true);
	});
});
