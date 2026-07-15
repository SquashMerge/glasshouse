import { describe, expect, it } from "bun:test";
import { normalizeSpan } from "../../src/db/gen-ai-attrs";
import { observationToInsertRow } from "../../src/db/observation-row";

const HASH = "a".repeat(64);

describe("insertObservations metadata", () => {
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
        { key: "astraea.prompt.rendered", value: { stringValue: "must not persist" } },
      ],
    } as never).observation;
    const row = observationToInsertRow(observation);
    expect(JSON.parse(row.metadata)).toEqual({
      schema_version: 1,
      attributes: [{ key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } }],
      prompt_provenance: { id: "support-agent", version: 7, content_hash: HASH },
    });
  });
});
