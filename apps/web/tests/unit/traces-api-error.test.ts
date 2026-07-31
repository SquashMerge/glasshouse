import { beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({
	authedFetch: vi.fn(),
}));

vi.mock("../../src/lib/auth", () => ({ authedFetch }));

import { ApiError, listTraces } from "../../src/lib/api";

describe("listTraces error contract", () => {
	beforeEach(() => {
		authedFetch.mockReset();
	});

	it("preserves a true HTTP 500 as a typed error with status and category", async () => {
		authedFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					code: "INTERNAL",
					message: "Query failed; check server logs",
				}),
				{ status: 500, headers: { "content-type": "application/json" } },
			),
		);

		await expect(listTraces({ project_id: "project-1" })).rejects.toMatchObject(
			{
				name: ApiError.name,
				status: 500,
				code: "INTERNAL",
				message: "Query failed; check server logs",
			},
		);
	});
});
