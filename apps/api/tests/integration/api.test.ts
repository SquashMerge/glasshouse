import { describe, it, expect, beforeAll, mock } from "bun:test";

const USER = "astraea";
const PASS = "secret";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
process.env.UI_USERNAME = USER;
process.env.UI_PASSWORD = PASS;

const { createApiApp } = await import("../../src/index");
const { createHealthHandler } = await import("../../src/routes/health");
const { createOtlpIngestHandler } = await import("../../src/routes/otlp");

const insertTraces = mock(() => Promise.resolve());
const insertObservations = mock(() => Promise.resolve());
const defaultClient = mock(() => ({}));
const apiApp = createApiApp({
  handleHealth: createHealthHandler({
    chPing: async () => "up",
    pgPing: async () => "up",
    valkeyPing: async () => "up",
  }),
  handleOtlpIngest: createOtlpIngestHandler({
    defaultClient,
    insertObservations,
    insertTraces,
    publishSync: () => undefined,
  }),
});

beforeAll(() => {
  process.env.UI_USERNAME = USER;
  process.env.UI_PASSWORD = PASS;
});

describe("API integration: health + openapi", () => {
  it("GET /health returns 200 without auth", async () => {
    const res = await apiApp.fetch(new Request("http://x/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("GET /openapi.json returns 200 without auth", async () => {
    const res = await apiApp.fetch(new Request("http://x/openapi.json"));
    expect(res.status).toBe(200);
    const document = (await res.json()) as {
      components?: { securitySchemes?: { basicAuth?: { type?: string; scheme?: string } } };
    };
    expect(document.components?.securitySchemes?.basicAuth).toEqual({ type: "http", scheme: "basic" });
  });

  it("GET /reference returns 200 without auth", async () => {
    const res = await apiApp.fetch(new Request("http://x/reference"));
    expect(res.status).toBe(200);
  });

  it("Every response includes the security headers", async () => {
    const res = await apiApp.fetch(new Request("http://x/health"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});

describe("API integration: auth gate", () => {
  it("GET /v1/traces without auth returns 401 with WWW-Authenticate", async () => {
    const res = await apiApp.fetch(new Request("http://x/v1/traces"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic realm="astraea"/);
  });

  it("POST /v1/auth/login with valid creds returns 200 { ok: true }", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/auth/login", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("POST /v1/auth/login with bad creds returns 401", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/auth/login", {
        method: "POST",
        headers: { authorization: "Basic " + Buffer.from("wrong:wrong").toString("base64") },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("API integration: OTLP ingest", () => {
  const HEX32 = "00112233445566778899aabbccddeeff";
  const HEX16 = "0011223344556677";
  const NOW_NS = 1_700_000_000_000_000_000;

  function validOtlp(extra: Record<string, unknown> = {}) {
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
                  start_time_unix_nano: String(NOW_NS),
                  attributes: [
                    { key: "gen_ai.system", value: { stringValue: "openai" } },
                  ],
                  ...extra,
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it("accepts a valid OTLP body and returns 200 with empty partial_success", async () => {
    insertTraces.mockClear();
    insertObservations.mockClear();

    const res = await apiApp.fetch(
      new Request("http://x/v1/otel/v1/traces", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify(validOtlp()),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { partial_success: unknown };
    expect(body.partial_success).toEqual({});
    expect(insertTraces).toHaveBeenCalledTimes(1);
    expect(insertObservations).toHaveBeenCalledTimes(1);
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/otel/v1/traces", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("returns 400 on Zod validation failure", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/otel/v1/traces", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({ resource_spans: [] }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("returns 401 without auth", async () => {
    const res = await apiApp.fetch(
      new Request("http://x/v1/otel/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validOtlp()),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("applies ASTRAEA_REDACT_INPUT=true when ingesting", async () => {
    process.env.ASTRAEA_REDACT_INPUT = "true";
    insertTraces.mockClear();
    insertObservations.mockClear();
    try {
      const res = await apiApp.fetch(
        new Request("http://x/v1/otel/v1/traces", {
          method: "POST",
          headers: { authorization: AUTH, "content-type": "application/json" },
          body: JSON.stringify(validOtlp({
            attributes: [
              { key: "gen_ai.prompt.0.content", value: { stringValue: "SECRET_PROMPT" } },
            ],
          })),
        }),
      );
      expect(res.status).toBe(200);
      const traces = insertTraces.mock.calls[0]?.[1] as Array<{ input_text: string }>;
      expect(traces[0]?.input_text).toBe("[REDACTED]");
    } finally {
      delete process.env.ASTRAEA_REDACT_INPUT;
    }
  });

  it("returns generic 500 on ClickHouse insert failure (no internals leaked)", async () => {
    insertTraces.mockImplementationOnce(() => Promise.reject(new Error("Connection refused: 10.0.0.1:8123")));
    const res = await apiApp.fetch(
      new Request("http://x/v1/otel/v1/traces", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify(validOtlp()),
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("INTERNAL");
    expect(body.message).not.toContain("Connection refused");
    expect(body.message).not.toContain("10.0.0.1");
  });
});

describe("API integration: body size limit", () => {
  it("rejects oversized bodies with 413", async () => {
    const big = "x".repeat(2_000_000);
    const res = await apiApp.fetch(
      new Request("http://x/v1/otel/v1/traces", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json", "content-length": String(big.length) },
        body: big,
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
