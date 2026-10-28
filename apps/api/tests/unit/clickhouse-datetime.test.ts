import { describe, expect, it } from "bun:test";
import { clickHouseDateTime } from "../../src/db/clickhouse-datetime.js";

describe("ClickHouse DateTime parameter formatting", () => {
	it("converts UTC RFC3339 values to ClickHouse's datetime parameter format", () => {
		expect(clickHouseDateTime("2026-10-28T12:34:56.789Z")).toBe(
			"2026-10-28 12:34:56.789",
		);
		expect(clickHouseDateTime("2026-10-28T12:34:56Z")).toBe(
			"2026-10-28 12:34:56",
		);
	});

	it("leaves non-matching values unchanged", () => {
		expect(clickHouseDateTime("2026-10-28 12:34:56")).toBe(
			"2026-10-28 12:34:56",
		);
	});
});
