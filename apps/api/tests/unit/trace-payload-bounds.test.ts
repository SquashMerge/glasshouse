import { describe, expect, it } from "bun:test";
import { REDACTED } from "../../src/db/redact";
import {
	MAX_RETAINED_METADATA_BYTES,
	MAX_RETAINED_TEXT_BYTES,
	boundObservationMetadata,
	boundText,
	fitResponseItems,
	MAX_TRACE_RESPONSE_BYTES,
} from "../../src/db/trace-payload-bounds";

describe("trace payload retention bounds", () => {
	it("accounts for redacted text and serialized metadata in UTF-8 bytes before storage", () => {
		const redacted = boundText(REDACTED, MAX_RETAINED_TEXT_BYTES);
		expect(redacted).toEqual({ value: REDACTED, truncated: false });

		const text = boundText(
			"😀".repeat(MAX_RETAINED_TEXT_BYTES),
			MAX_RETAINED_TEXT_BYTES,
		);
		expect(new TextEncoder().encode(text.value).byteLength).toBe(
			MAX_RETAINED_TEXT_BYTES,
		);
		expect(text.truncated).toBe(true);

		const metadata = boundObservationMetadata({
			schema_version: 1,
			attributes: Array.from({ length: 128 }, (_, index) => ({
				key: `safe.${index}`,
				value: { stringValue: "界".repeat(MAX_RETAINED_METADATA_BYTES) },
			})),
			prompt_provenance: null,
		});
		expect(
			new TextEncoder().encode(JSON.stringify(metadata)).byteLength,
		).toBeLessThanOrEqual(MAX_RETAINED_METADATA_BYTES);
		expect(metadata.truncated).toBe(true);
		expect(
			metadata.attributes.every((attribute) => {
				const value = attribute.value as { stringValue?: unknown } | undefined;
				return (
					typeof value?.stringValue !== "string" ||
					!value.stringValue.includes("\uFFFD")
				);
			}),
		).toBe(true);
	});

	it("stops before a response exceeds its encoded byte ceiling", () => {
		const result = fitResponseItems(
			Array.from({ length: 100 }, (_, index) => ({
				id: index,
				output: "界".repeat(2_000),
			})),
			(items) => ({ items, total: 100 }),
			MAX_TRACE_RESPONSE_BYTES,
		);
		expect(result.truncated).toBe(true);
		expect(result.items.length).toBeGreaterThan(0);
		expect(
			new TextEncoder().encode(
				JSON.stringify({ items: result.items, total: 100 }),
			).byteLength,
		).toBeLessThanOrEqual(MAX_TRACE_RESPONSE_BYTES);
	});
});
