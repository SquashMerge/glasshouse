import { describe, expect, it } from "bun:test";
import { renewOptimizationLease } from "../../src/routes/prompt-optimizations";

describe("optimization lease renewal", () => {
	it("aborts the worker when renewal rejects instead of leaking an unhandled rejection", async () => {
		const controller = new AbortController();
		await renewOptimizationLease({
			job_id: "22222222-2222-4222-8222-222222222222",
			controller,
			renew: async () => {
				throw new Error("postgres unavailable");
			},
		});
		expect(controller.signal.aborted).toBe(true);
	});
});
