import { describe, expect, it } from "vitest";
import {
	parseObservabilitySearch,
	serializeObservabilitySearch,
} from "../../src/lib/observability-search";

describe("observability URL state", () => {
	it("round-trips a traces view with filters and a custom time range", () => {
		const state = parseObservabilitySearch(
			"?tab=traces&traces.name=llm.call&traces.status=error&traces.range=custom&traces.from=2026-07-30T09%3A00&traces.to=2026-07-30T10%3A00",
			"traces",
			["name", "status", "agent_id"],
		);

		expect(state).toEqual({
			filters: { name: "llm.call", status: "error", agent_id: "" },
			timeRange: {
				kind: "custom",
				from: "2026-07-30T09:00",
				to: "2026-07-30T10:00",
			},
		});
		expect(serializeObservabilitySearch("?tab=traces", "traces", state)).toBe(
			"?tab=traces&traces.name=llm.call&traces.status=error&traces.range=custom&traces.from=2026-07-30T09%3A00&traces.to=2026-07-30T10%3A00",
		);
	});

	it("keeps unrelated tab state while clearing an all-time empty view", () => {
		const state = parseObservabilitySearch(
			"?tab=spans&spans.name=tool",
			"traces",
			["name"],
		);
		expect(state).toEqual({
			filters: { name: "" },
			timeRange: { kind: "all" },
		});
		expect(
			serializeObservabilitySearch(
				"?tab=spans&spans.name=tool",
				"traces",
				state,
			),
		).toBe("?tab=spans&spans.name=tool");
	});
});
