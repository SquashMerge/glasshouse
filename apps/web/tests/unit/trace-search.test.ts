import { describe, expect, it } from "vitest";
import {
	revealSearchAncestors,
	searchTraceObservations,
} from "../../src/lib/trace-search";

const observations = [
	{
		observation_id: "root",
		trace_id: "trace-1",
		name: "HTTP request",
		status: "ok",
		service_name: "gateway",
		metadata: '[{"key":"user.id","value":"ada"}]',
	},
	{
		observation_id: "child",
		parent_observation_id: "root",
		trace_id: "trace-1",
		name: "model call",
		status: "error",
		metadata: "[REDACTED]",
	},
];

describe("trace search", () => {
	it("searches supplied names, services, IDs, status, and raw metadata", () => {
		expect(searchTraceObservations(observations, "gateway").matchIds).toEqual([
			"root",
		]);
		expect(searchTraceObservations(observations, "trace-1").matchIds).toEqual([
			"root",
			"child",
		]);
		expect(searchTraceObservations(observations, "error").matchIds).toEqual([
			"child",
		]);
		expect(
			searchTraceObservations(observations, "[redacted]").matchIds,
		).toEqual(["child"]);
	});

	it("reveals match ancestors without replacing a user's existing expansion", () => {
		const expanded = revealSearchAncestors(
			new Set(["already-open"]),
			["child"],
			(id) => (id === "child" ? ["root"] : []),
		);

		expect(expanded).toEqual(new Set(["already-open", "root"]));
	});
});
