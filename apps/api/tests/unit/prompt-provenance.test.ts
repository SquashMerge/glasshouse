import { describe, expect, it } from "bun:test";
import { normalizeSpan } from "../../src/db/gen-ai-attrs";

const TRACE_ID = "00112233445566778899aabbccddeeff";
const SPAN_ID = "0011223344556677";
const HASH = "a".repeat(64);

const tuple = [
  { key: "astraea.prompt.id", value: { stringValue: "support-agent" } },
  { key: "astraea.prompt.version", value: { intValue: 7 } },
  { key: "astraea.prompt.content_hash", value: { stringValue: HASH } },
];

function normalize(attributes: unknown[]) {
  return normalizeSpan({
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
    name: "generation",
    start_time_unix_nano: 1_700_000_000_000_000_000,
    attributes: [
      { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
      ...attributes,
    ],
  } as never).observation;
}

describe("prompt provenance OTLP normalization", () => {
  it("stores one exact valid generation tuple in the metadata envelope", () => {
    const observation = normalize(tuple);
    expect(observation.metadata).toEqual({
      schema_version: 1,
      attributes: [{ key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } }],
      prompt_provenance: { id: "support-agent", version: 7, content_hash: HASH },
    });
  });

  it("accepts the current canonical decimal string intValue representation", () => {
    const observation = normalize([
      tuple[0],
      { key: "astraea.prompt.version", value: { intValue: "7" } },
      tuple[2],
    ]);
    expect(observation.metadata.prompt_provenance).toEqual({
      id: "support-agent",
      version: 7,
      content_hash: HASH,
    });
  });

  for (const missing of ["astraea.prompt.id", "astraea.prompt.version", "astraea.prompt.content_hash"]) {
    it(`rejects provenance when ${missing} is missing`, () => {
      expect(normalize(tuple.filter((attribute) => attribute.key !== missing)).metadata.prompt_provenance).toBeNull();
    });
  }

  for (const duplicate of ["astraea.prompt.id", "astraea.prompt.version", "astraea.prompt.content_hash"]) {
    it(`rejects provenance when ${duplicate} is duplicated`, () => {
      const attribute = tuple.find((candidate) => candidate.key === duplicate)!;
      expect(normalize([...tuple, attribute]).metadata.prompt_provenance).toBeNull();
    });
  }

  for (const malformed of [
    { key: "astraea.prompt.id", value: { stringValue: "Support Agent" } },
    { key: "astraea.prompt.version", value: { intValue: "07" } },
    { key: "astraea.prompt.content_hash", value: { stringValue: HASH.toUpperCase() } },
  ]) {
    it(`rejects malformed ${malformed.key}`, () => {
      expect(normalize(tuple.map((attribute) => attribute.key === malformed.key ? malformed : attribute)).metadata.prompt_provenance).toBeNull();
    });
  }

  it("rejects a tuple on a non-generation observation", () => {
    const observation = normalizeSpan({
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      name: "generic",
      start_time_unix_nano: 1_700_000_000_000_000_000,
      attributes: tuple,
    } as never).observation;
    expect(observation.type).toBe("span");
    expect(observation.metadata.prompt_provenance).toBeNull();
  });

  it("strips every prompt namespace attribute without changing gen_ai extraction", () => {
    const observation = normalize([
      ...tuple,
      { key: "astraea.prompt.template", value: { stringValue: "secret template" } },
      { key: "astraea.prompt.variables", value: { stringValue: "secret variables" } },
      { key: "custom.value", value: { stringValue: "retained" } },
    ]);
    expect(observation.model).toBe("gpt-4o");
    expect(observation.metadata.attributes).toEqual([
      { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
      { key: "custom.value", value: { stringValue: "retained" } },
    ]);
  });
});
