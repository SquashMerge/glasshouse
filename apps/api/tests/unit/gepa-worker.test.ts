import { afterEach, describe, expect, it } from "bun:test";
import { runGepaWorker } from "../../src/lib/gepa-worker";

describe("GEPA worker adapter", () => {
  const prior = process.env.GEPA_WORKER_MODE;
  afterEach(() => { process.env.GEPA_WORKER_MODE = prior; });

  it("uses the deterministic credential-free worker mode", async () => {
    process.env.GEPA_WORKER_MODE = "fake";
    const result = await runGepaWorker({ target: "system", source: "Hello {{name}}", evaluator: {}, examples: [{}], model_config: {}, budget: {} }, new AbortController().signal);
    expect(result.candidate).toContain("Hello {{name}}");
  });
});
