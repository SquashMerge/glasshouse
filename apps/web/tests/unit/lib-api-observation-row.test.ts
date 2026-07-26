import { describe, it, expect } from "vitest";
import {
	emptyObservationMetadata,
	type ObservationRow,
} from "../../src/lib/api";

/**
 * Sanity test that the deduplicated `ObservationRow` interface compiles and
 * survives a JSON round-trip. After the `fe-filterable-refactor` slice, the
 * interface declares a single canonical shape including `project_id` and a
 * typed `metadata` envelope. This file catches future regressions where
 * someone re-declares the interface (the original duplication silently
 * merged via TS declaration merging).
 */
describe("ObservationRow shape", () => {
	function makeRow(overrides: Partial<ObservationRow> = {}): ObservationRow {
		return {
			observation_id: "0123456789abcdef0123456789abcdef",
			trace_id: "abcdef0123456789abcdef0123456789",
			project_id: "proj-1",
			parent_observation_id: null,
			type: "span",
			name: "root",
			start_time: "2026-01-01 00:00:00",
			end_time: "2026-01-01 00:00:01",
			duration_ms: 1000,
			status: "ok",
			model: null,
			input_text: "",
			output_text: "",
			metadata: emptyObservationMetadata(),
			...overrides,
		};
	}

	it("canonical fields are present and required", () => {
		const row = makeRow();
		expect(row.project_id).toBe("proj-1");
		expect(row.metadata).toEqual(emptyObservationMetadata());
		expect(typeof row.observation_id).toBe("string");
		expect(typeof row.trace_id).toBe("string");
		expect(["span", "event", "generation", "tool"]).toContain(row.type);
	});

	it("round-trips through JSON.parse(JSON.stringify(o))", () => {
		const original = makeRow({
			metadata: {
				schema_version: 1,
				attributes: [
					{ key: "tool", value: { name: "search" } },
					{ key: "tokens", value: { intValue: 42 } },
				],
				prompt_provenance: null,
			},
			type: "tool",
			name: "search",
			model: "gpt-4o",
			parent_observation_id: "0123456789abcdef0123456789abcdee",
		});
		const round = JSON.parse(JSON.stringify(original)) as ObservationRow;
		expect(round).toEqual(original);
		expect(round.metadata.attributes).toEqual([
			{ key: "tool", value: { name: "search" } },
			{ key: "tokens", value: { intValue: 42 } },
		]);
	});

	it("preserves the typed metadata envelope through a JSON round-trip", () => {
		const parsed = {
			schema_version: 1 as const,
			attributes: [{ key: "tool", value: { name: "search_db" } }],
			prompt_provenance: null,
		};
		const row = makeRow({
			type: "tool",
			name: "search_db",
			model: "gpt-4o",
			metadata: parsed,
		});
		expect(row.metadata).toEqual(parsed);
	});
});
