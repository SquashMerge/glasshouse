import { describe, expect, it } from "bun:test";
import { normalizeSpan } from "../../src/db/gen-ai-attrs";
import { insertObservations } from "../../src/db/traces-writer";

const HASH = "a".repeat(64);

describe("insertObservations metadata", () => {
  it("writes the versioned metadata envelope as a ClickHouse string", async () => {
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
    let values: Array<Record<string, unknown>> = [];
    await insertObservations({
      insert: async (request: { values: Array<Record<string, unknown>> }) => {
        values = request.values;
      },
    } as never, [observation]);

    expect(JSON.parse(values[0]?.metadata as string)).toEqual({
      schema_version: 1,
      attributes: [{ key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } }],
      prompt_provenance: { id: "support-agent", version: 7, content_hash: HASH },
    });
  });
});
