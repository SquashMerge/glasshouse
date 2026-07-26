import { describe, expect, it, vi } from "vitest";
import {
	formatMetadata,
	metadataAttributes,
	metadataFallback,
	parseMetadata,
} from "../../src/lib/trace-metadata";
import { searchTraceObservations } from "../../src/lib/trace-search";

describe("trace metadata", () => {
	it("returns visible fallbacks for absent and malformed metadata without logging", () => {
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		const absent = parseMetadata(undefined);
		const malformed = parseMetadata("not-json");

		expect(absent.state).toBe("absent");
		expect(metadataFallback(absent)).toBe("No metadata supplied.");
		expect(malformed.state).toBe("malformed");
		expect(metadataFallback(malformed)).toBe("Metadata could not be parsed.");
		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("formats valid metadata and extracts sorted supplied attributes", () => {
		const parsed = parseMetadata(
			JSON.stringify([
				{ key: "z", value: "[REDACTED]" },
				{ key: "a", value: 1 },
			]),
		);

		expect(formatMetadata(parsed)).toContain("[REDACTED]");
		expect(metadataAttributes(parsed)).toEqual([
			{ key: "a", value: 1 },
			{ key: "z", value: "[REDACTED]" },
		]);
	});

	it("does not parse raw metadata when searching", () => {
		const parse = vi.spyOn(JSON, "parse");

		expect(
			searchTraceObservations(
				[
					{
						observation_id: "a",
						metadata: "malformed but searchable",
						name: "name",
					},
				],
				"searchable",
			).matchIds,
		).toEqual(["a"]);
		expect(parse).not.toHaveBeenCalled();
		parse.mockRestore();
	});
});
