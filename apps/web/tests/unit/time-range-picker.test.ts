import { describe, expect, it } from "vitest";
import {
	isTimeRangeValid,
	timeRangeError,
	toApiParams,
} from "../../src/components/TimeRangePicker";

describe("TimeRangePicker custom ranges", () => {
	it("does not create a partial query for an incomplete custom range", () => {
		const range = { kind: "custom" as const, from: "2026-01-01T10:00", to: "" };
		expect(timeRangeError(range)).toBe("Enter both a start and end time.");
		expect(isTimeRangeValid(range)).toBe(false);
		expect(toApiParams(range)).toEqual({});
	});

	it("rejects a custom range whose start is after its end", () => {
		const range = {
			kind: "custom" as const,
			from: "2026-01-02T10:00",
			to: "2026-01-01T10:00",
		};
		expect(timeRangeError(range)).toBe(
			"The start time must be before the end time.",
		);
		expect(isTimeRangeValid(range)).toBe(false);
	});

	it("converts a complete ordered custom range to API parameters", () => {
		const range = {
			kind: "custom" as const,
			from: "2026-01-01T10:00",
			to: "2026-01-01T11:00",
		};
		expect(isTimeRangeValid(range)).toBe(true);
		expect(toApiParams(range)).toEqual({
			time_from: expect.stringMatching(/^2026-01-01 \d{2}:00:00$/),
			time_to: expect.stringMatching(/^2026-01-01 \d{2}:00:00$/),
		});
	});
});
