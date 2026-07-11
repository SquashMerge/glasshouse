// Unit tests for the OTLP request schema (Zod validation).
// Verifies that valid payloads parse and invalid ones reject with typed errors.

import { describe, it, expect } from "bun:test";
import { ExportTraceServiceRequest, ExportTraceServiceResponse, Span } from "../../src/schemas/otlp";

const HEX32 = "00112233445566778899aabbccddeeff";
const HEX16 = "0011223344556677";
const NOW_NS = 1_700_000_000_000_000_000;

function validPayload(extra: Record<string, unknown> = {}) {
  return {
    resource_spans: [
      {
        resource: { attributes: [] },
        scope_spans: [
          {
            scope: { name: "test", version: "1.0.0" },
            spans: [
              {
                trace_id: HEX32,
                span_id: HEX16,
                name: "test-span",
                kind: 1,
                start_time_unix_nano: String(NOW_NS),
                end_time_unix_nano: String(NOW_NS + 50_000_000),
                attributes: [],
                status: { code: 1 },
                ...extra,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("ExportTraceServiceRequest Zod validation", () => {
  it("accepts a minimal valid payload", () => {
    const result = ExportTraceServiceRequest.safeParse(validPayload());
    expect(result.success).toBe(true);
  });

  it("rejects payload with invalid trace_id (not 32 hex)", () => {
    const result = ExportTraceServiceRequest.safeParse(
      validPayload({ trace_id: "tooshort" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects payload with invalid span_id (not 16 hex)", () => {
    const result = ExportTraceServiceRequest.safeParse(
      validPayload({ span_id: "tooshort" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects payload with uppercase hex (must be lowercase)", () => {
    const result = ExportTraceServiceRequest.safeParse(
      validPayload({ trace_id: HEX32.toUpperCase() }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects empty resource_spans array", () => {
    const result = ExportTraceServiceRequest.safeParse({ resource_spans: [] });
    expect(result.success).toBe(false);
  });

  it("rejects empty spans array inside scope_spans", () => {
    const result = ExportTraceServiceRequest.safeParse({
      resource_spans: [{ resource: { attributes: [] }, scope_spans: [{ spans: [] }] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects span with empty name", () => {
    const result = ExportTraceServiceRequest.safeParse(validPayload({ name: "" }));
    expect(result.success).toBe(false);
  });

  it("accepts end_time_unix_nano as a number (transforms to number)", () => {
    const result = ExportTraceServiceRequest.safeParse(
      validPayload({ start_time_unix_nano: NOW_NS, end_time_unix_nano: NOW_NS + 100 }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts end_time_unix_nano as a string (transforms to number)", () => {
    const result = ExportTraceServiceRequest.safeParse(
      validPayload({ end_time_unix_nano: String(NOW_NS + 100) }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts missing end_time_unix_nano (in-flight spans)", () => {
    const { end_time_unix_nano: _ignored, ...span } = validPayload();
    const result = ExportTraceServiceRequest.safeParse({ resource_spans: [
      { resource: { attributes: [] }, scope_spans: [{ spans: [span] }] }
    ] });
    expect(result.success).toBe(true);
  });

  it("accepts all valid SpanKind enum values (0..5)", () => {
    for (const kind of [0, 1, 2, 3, 4, 5]) {
      const result = ExportTraceServiceRequest.safeParse(validPayload({ kind }));
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid SpanKind (e.g. 6)", () => {
    const result = ExportTraceServiceRequest.safeParse(validPayload({ kind: 6 }));
    expect(result.success).toBe(false);
  });
});

describe("ExportTraceServiceResponse Zod validation", () => {
  it("accepts an empty response", () => {
    expect(ExportTraceServiceResponse.safeParse({ partial_success: {} }).success).toBe(true);
  });

  it("accepts a response with rejected_spans count", () => {
    expect(ExportTraceServiceResponse.safeParse({
      partial_success: { rejected_spans: 5, error_message: "x" },
    }).success).toBe(true);
  });
});

describe("SpanKind enum", () => {
  it("rejects kind outside 0..5", () => {
    expect(Span.safeParse({ ...validPayload(), kind: 7 }).success).toBe(false);
  });
});