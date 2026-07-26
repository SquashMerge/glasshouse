import { describe, expect, it } from "vitest";
import { observationKind } from "../../src/lib/observation-kind";

describe("observationKind", () => {
	it.each([
		["span", "Span"],
		["event", "Event"],
		["generation", "Generation"],
		["tool", "Tool"],
	])("maps the persisted %s type to a friendly label", (type, label) => {
		expect(observationKind(type)).toMatchObject({ type, label });
	});

	it("keeps unknown persisted values neutral instead of classifying them", () => {
		expect(observationKind("future-type")).toEqual({
			type: null,
			label: "Unknown",
			icon: "?",
			color: "slate",
		});
	});
});
