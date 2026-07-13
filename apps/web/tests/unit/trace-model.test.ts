import { describe, expect, it } from "vitest";
import {
  createTraceModel,
  getObservationHighlightVersion,
  traceModelObservations,
  traceModelRawPayload,
  upsertLiveObservation,
} from "../../src/lib/trace-model";

describe("trace model", () => {
  it("uses trimmed nonempty IDs and lets the last snapshot duplicate win", () => {
    const model = createTraceModel({
      trace: { trace_id: "trace-1" },
      observations: [
        { observation_id: " first ", name: "old" },
        { observation_id: "first", name: "new" },
        { observation_id: "", name: "empty" },
        { observation_id: 1, name: "number" },
      ],
    });

    expect(model.observationIds).toEqual(["first"]);
    expect(model.observationsById.get("first")?.name).toBe("new");
    expect(model.malformedObservationCount).toBe(2);
  });

  it("upserts live rows and advances only the changed row highlight version", () => {
    const snapshot = createTraceModel({
      observations: [{ observation_id: "a" }, { observation_id: "b" }],
    });
    const next = upsertLiveObservation(snapshot, { observation_id: "a", name: "replacement" });

    expect(next.observationsById.get("a")?.name).toBe("replacement");
    expect(getObservationHighlightVersion(next, "a")).toBe(1);
    expect(getObservationHighlightVersion(next, "b")).toBe(0);
  });

  it("counts malformed live rows without changing valid data", () => {
    const model = createTraceModel({ observations: [{ observation_id: "a" }] });
    const next = upsertLiveObservation(model, { observation_id: "  " });

    expect(next.observationIds).toEqual(["a"]);
    expect(next.malformedObservationCount).toBe(1);
  });

  it("exposes only canonical current rows in the raw payload adapter", () => {
    const model = createTraceModel({
      trace: { trace_id: "trace-1" },
      observations: [{ observation_id: "a", metadata: "[REDACTED]" }],
    });

    expect(traceModelObservations(model)).toEqual([{ observation_id: "a", metadata: "[REDACTED]" }]);
    expect(traceModelRawPayload(model)).toEqual({
      trace: { trace_id: "trace-1" },
      observations: [{ observation_id: "a", metadata: "[REDACTED]" }],
    });
  });
});
