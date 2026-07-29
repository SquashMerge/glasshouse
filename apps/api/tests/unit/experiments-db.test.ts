import { describe, expect, it } from "bun:test";
import { failInterruptedExperiments } from "../../src/db/experiments";

describe("experiment recovery", () => {
	it("marks pending and running experiments failed at API startup", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const db = {
			query: async (text: string, values: unknown[] = []) => {
				calls.push({ text, values });
				return {
					rows: [
						{
							id: "33333333-3333-4333-8333-333333333333",
							project_id: "11111111-1111-4111-8111-111111111111",
						},
					],
				};
			},
		};

		expect(await failInterruptedExperiments(db)).toEqual([
			{
				id: "33333333-3333-4333-8333-333333333333",
				project_id: "11111111-1111-4111-8111-111111111111",
			},
		]);
		expect(calls[0]?.text).toContain("status IN ('pending','running')");
		expect(calls[0]?.text).toContain("SET status='failed'");
	});
});
