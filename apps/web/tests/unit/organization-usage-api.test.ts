import { describe, expect, it, vi } from "vitest";

const authedFetch = vi.fn();
vi.mock("../../src/lib/auth", () => ({
	authedFetch: (...args: unknown[]) => authedFetch(...args),
}));

import { getOrganizationUsage } from "../../src/lib/api";

describe("organization usage API client", () => {
	it("requests only the caller's current organization with an explicit range", async () => {
		const body = {
			range: "7d",
			from: "2026-10-21T00:00:00.000Z",
			to: "2026-10-28T00:00:00.000Z",
			projects: [],
			totals: {
				traces: 0,
				observations: 0,
				observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
			},
			series: [],
		};
		authedFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => body,
		});

		expect(await getOrganizationUsage("7d")).toEqual(body);
		expect(authedFetch).toHaveBeenCalledWith("/v1/organization/usage?range=7d");
	});
});
