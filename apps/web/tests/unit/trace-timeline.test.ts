import { describe, expect, it } from "vitest";
import {
	clampPercent,
	createTraceTimeline,
	observationTiming,
	parseClickHouseUtc,
} from "../../src/lib/trace-timeline";

const observation = (
	observation_id: string,
	extra: Record<string, unknown> = {},
) => ({
	observation_id,
	start_time: "2026-01-01 00:00:00.000",
	end_time: null,
	duration_ms: 100,
	...extra,
});

describe("trace timeline", () => {
	it("parses ClickHouse zone-less timestamps explicitly as UTC", () => {
		expect(parseClickHouseUtc("2026-01-01 00:00:00.123")).toBe(
			Date.UTC(2026, 0, 1, 0, 0, 0, 123),
		);
		expect(parseClickHouseUtc("2026-02-30 00:00:00.000")).toBeNull();
	});

	it("fails safely for unset duration and end-before-start", () => {
		expect(
			observationTiming(observation("a", { duration_ms: null })),
		).toMatchObject({
			isRenderable: false,
			warnings: ["duration_unset"],
		});
		expect(
			observationTiming(
				observation("b", { end_time: "2025-12-31 23:59:59.999" }),
			),
		).toMatchObject({
			isRenderable: false,
			warnings: ["end_before_start"],
		});
	});

	it("creates finite clamped bar styles and reports invalid rows", () => {
		const timeline = createTraceTimeline([
			observation("a"),
			observation("b", {
				start_time: "2026-01-01 00:00:00.050",
				duration_ms: 50,
			}),
			observation("invalid", { start_time: "bad" }),
		]);

		expect(timeline.bars).toHaveLength(2);
		expect(
			timeline.bars.every(
				(bar) =>
					Number.isFinite(bar.leftPercent) && Number.isFinite(bar.widthPercent),
			),
		).toBe(true);
		expect(timeline.invalidObservationIds).toEqual(["invalid"]);
		expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
		expect(clampPercent(-10)).toBe(0);
		expect(clampPercent(110)).toBe(100);
	});
});
