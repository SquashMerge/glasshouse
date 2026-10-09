import { describe, expect, it } from "bun:test";
import { normalizeSpan } from "../../src/db/gen-ai-attrs";
import { observationToInsertRow } from "../../src/db/observation-row";
import { insertTraces } from "../../src/db/traces-writer";
import {
	MAX_RETAINED_METADATA_BYTES,
	MAX_RETAINED_TEXT_BYTES,
} from "../../src/db/trace-payload-bounds";

const HASH = "a".repeat(64);

describe("insertObservations metadata", () => {
	it("persists byte-accurate retained-text truncation state for ASCII and Unicode", async () => {
		const { trace, observation } = normalizeSpan({
			trace_id: "00112233445566778899aabbccddeeff",
			span_id: "0011223344556677",
			name: "retained-state",
			start_time_unix_nano: 1_700_000_000_000_000_000,
			attributes: [
				{
					key: "input.value",
					value: { stringValue: "a".repeat(MAX_RETAINED_TEXT_BYTES + 1) },
				},
				{
					key: "output.value",
					value: { stringValue: "界".repeat(2_731) },
				},
			],
		} as never);
		trace.organization_id = "00000000-0000-4000-8000-000000000001";
		trace.project_id = "11111111-1111-4111-8111-1111-111111111111";
		observation.organization_id = trace.organization_id;
		observation.project_id = trace.project_id;
		const inserts: unknown[] = [];
		const client = { insert: async (input: unknown) => inserts.push(input) };

		await insertTraces(client as never, [trace], "retained-state");
		const traceRow = (inserts[0] as { values: Array<Record<string, unknown>> })
			.values[0]!;
		const observationRow = observationToInsertRow(observation);

		expect(traceRow.input_retained_truncated).toBe(true);
		expect(traceRow.output_retained_truncated).toBe(true);
		expect(observationRow.input_retained_truncated).toBe(true);
		expect(observationRow.output_retained_truncated).toBe(true);
		expect(
			new TextEncoder().encode(traceRow.input_text as string).byteLength,
		).toBe(MAX_RETAINED_TEXT_BYTES);
		expect(
			new TextEncoder().encode(traceRow.output_text as string).byteLength,
		).toBeLessThanOrEqual(MAX_RETAINED_TEXT_BYTES);
	});

	it("enforces the durable byte ceilings at the ClickHouse writer boundary", async () => {
		const { trace, observation } = normalizeSpan({
			trace_id: "00112233445566778899aabbccddeeff",
			span_id: "0011223344556677",
			name: "bounded",
			start_time_unix_nano: 1_700_000_000_000_000_000,
			attributes: [
				{ key: "input.value", value: { stringValue: "界".repeat(20_000) } },
				{ key: "safe", value: { stringValue: "界".repeat(20_000) } },
			],
		} as never);
		trace.organization_id = "00000000-0000-4000-8000-000000000001";
		trace.project_id = "11111111-1111-4111-8111-1111-111111111111";
		observation.organization_id = trace.organization_id;
		observation.project_id = trace.project_id;
		const inserts: unknown[] = [];
		const client = { insert: async (input: unknown) => inserts.push(input) };

		await insertTraces(client as never, [trace], "test-token");
		const traceRow = (inserts[0] as { values: Array<Record<string, string>> })
			.values[0]!;
		expect(
			new TextEncoder().encode(traceRow.input_text).byteLength,
		).toBeLessThanOrEqual(MAX_RETAINED_TEXT_BYTES);
		const observationRow = observationToInsertRow(observation);
		expect(
			new TextEncoder().encode(observationRow.metadata).byteLength,
		).toBeLessThanOrEqual(MAX_RETAINED_METADATA_BYTES);
	});

	it("retains normalized project IDs in both ClickHouse row mappings", async () => {
		const { trace, observation } = normalizeSpan({
			trace_id: "00112233445566778899aabbccddeeff",
			span_id: "0011223344556677",
			name: "project-scoped",
			start_time_unix_nano: 1_700_000_000_000_000_000,
			attributes: [],
		} as never);
		trace.project_id = "11111111-1111-4111-8111-111111111111";
		observation.project_id = trace.project_id;
		const inserts: unknown[] = [];
		const client = { insert: async (input: unknown) => inserts.push(input) };

		await insertTraces(client as never, [trace], "test-token");

		expect(
			(inserts[0] as { values: Array<{ project_id: string }> }).values[0],
		).toMatchObject({ project_id: trace.project_id });
		expect(
			(
				inserts[0] as {
					clickhouse_settings: Record<string, string | number>;
				}
			).clickhouse_settings,
		).toEqual({
			insert_deduplicate: 1,
			insert_deduplication_token: "test-token",
		});
		expect(observationToInsertRow(observation)).toMatchObject({
			project_id: trace.project_id,
		});
	});

	it("maps the versioned metadata envelope to the ClickHouse metadata column", () => {
		const observation = normalizeSpan({
			trace_id: "00112233445566778899aabbccddeeff",
			span_id: "0011223344556677",
			name: "generation",
			start_time_unix_nano: 1_700_000_000_000_000_000,
			attributes: [
				{ key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
				{
					key: "glasshouse.prompt.id",
					value: { stringValue: "support-agent" },
				},
				{ key: "glasshouse.prompt.version", value: { intValue: 7 } },
				{ key: "glasshouse.prompt.content_hash", value: { stringValue: HASH } },
				{
					key: "glasshouse.prompt.rendered",
					value: { stringValue: "must not persist" },
				},
			],
		} as never).observation;
		const row = observationToInsertRow(observation);
		expect(JSON.parse(row.metadata)).toEqual({
			schema_version: 1,
			attributes: [
				{ key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
			],
			prompt_provenance: {
				id: "support-agent",
				version: 7,
				content_hash: HASH,
			},
		});
	});
});
