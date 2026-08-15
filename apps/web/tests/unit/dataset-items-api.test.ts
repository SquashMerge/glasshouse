import { beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({
	authedFetch: vi.fn(),
}));

vi.mock("../../src/lib/auth", () => ({ authedFetch }));

import { listDatasetItems } from "../../src/lib/api";

describe("listDatasetItems", () => {
	beforeEach(() => {
		authedFetch.mockReset();
	});

	it("forwards the query cancellation signal to the request", async () => {
		const controller = new AbortController();
		authedFetch.mockResolvedValue(
			new Response(JSON.stringify({ items: [] }), { status: 200 }),
		);

		await listDatasetItems({
			project_id: "project-1",
			id: "dataset-1",
			signal: controller.signal,
		});

		expect(authedFetch).toHaveBeenCalledWith(
			"/v1/datasets/dataset-1/items?project_id=project-1",
			{ signal: controller.signal },
		);
	});
});
