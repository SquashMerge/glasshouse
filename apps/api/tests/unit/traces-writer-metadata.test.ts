import { describe, expect, it } from "bun:test";
import { normalizeSpan } from "../../src/db/gen-ai-attrs";
import { observationToInsertRow } from "../../src/db/observation-row";
import { insertTraces } from "../../src/db/traces-writer";

const HASH = "a".repeat(64);

describe("insertObservations metadata", () => {
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
				{ key: "astraea.prompt.id", value: { stringValue: "support-agent" } },
				{ key: "astraea.prompt.version", value: { intValue: 7 } },
				{ key: "astraea.prompt.content_hash", value: { stringValue: HASH } },
				{
					key: "astraea.prompt.rendered",
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
