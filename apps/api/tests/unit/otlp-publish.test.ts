// Verifies that POST /v1/otel/v1/traces publishes one trace.created event
// per inserted trace row and one observation.created event per observation.
// We mock the ClickHouse writer so no DB is required and we can count calls.

import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import {
	_resetForTests,
	publishSync,
	subscribe,
} from "../../src/lib/event-bus";
import { createOtlpIngestHandler } from "../../src/routes/otlp";

const insertTraces = mock(() => Promise.resolve());
const insertObservations = mock(() => Promise.resolve());
const defaultClient = mock(() => ({}));
const handleOtlpIngest = createOtlpIngestHandler({
	defaultClient,
	insertObservations,
	insertTraces,
	publishSync,
});

const USER = "astraea";
const PASS = "secret";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

const HEX32_A = "00112233445566778899aabbccddeeff";
const HEX32_B = "00112233445566778899aabbccddeefe";
const HEX16_A = "0011223344556677";
const HEX16_B = "0011223344556678";
const NOW_NS = 1_700_000_000_000_000_000;
const HASH = "a".repeat(64);

beforeAll(() => {
	process.env.UI_USERNAME = USER;
	process.env.UI_PASSWORD = PASS;
});

beforeEach(() => {
	delete process.env.VALKEY_PUBSUB_URL;
	insertTraces.mockClear();
	insertObservations.mockClear();
	_resetForTests();
});

function validOtlp(spans: Array<Record<string, unknown>>) {
	return {
		resource_spans: [
			{
				resource: { attributes: [] },
				scope_spans: [
					{
						scope: { name: "test", version: "1.0.0" },
						spans,
					},
				],
			},
		],
	};
}

describe("OTLP ingest publishes events", () => {
	it("one trace.created + one observation.created for a single-span payload", async () => {
		const traces: unknown[] = [];
		const observations: unknown[] = [];
		subscribe("trace.created", (m) => traces.push(m));
		subscribe("observation.created", (m) => observations.push(m));

		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify(
					validOtlp([
						{
							trace_id: HEX32_A,
							span_id: HEX16_A,
							name: "single-span",
							start_time_unix_nano: String(NOW_NS),
							attributes: [],
						},
					]),
				),
			}),
		);
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 5));

		expect(traces).toHaveLength(1);
		expect(observations).toHaveLength(1);
		expect((traces[0] as { event: string }).event).toBe("trace.created");
		expect((observations[0] as { event: string }).event).toBe(
			"observation.created",
		);
		expect(insertTraces).toHaveBeenCalledTimes(1);
		expect(insertObservations).toHaveBeenCalledTimes(1);
	});

	it("two trace.created + two observation.created for two spans (different trace_ids)", async () => {
		const traces: unknown[] = [];
		const observations: unknown[] = [];
		subscribe("trace.created", (m) => traces.push(m));
		subscribe("observation.created", (m) => observations.push(m));

		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify(
					validOtlp([
						{
							trace_id: HEX32_A,
							span_id: HEX16_A,
							name: "span-a",
							start_time_unix_nano: String(NOW_NS),
							attributes: [],
						},
						{
							trace_id: HEX32_B,
							span_id: HEX16_B,
							name: "span-b",
							start_time_unix_nano: String(NOW_NS + 1000),
							attributes: [],
						},
					]),
				),
			}),
		);
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 5));

		expect(traces).toHaveLength(2);
		expect(observations).toHaveLength(2);
		const traceIds = traces.map(
			(t) =>
				(t as { payload: { trace: { trace_id: string } } }).payload.trace
					.trace_id,
		);
		expect(new Set(traceIds)).toEqual(new Set([HEX32_A, HEX32_B]));
		const obsIds = observations.map(
			(o) =>
				(o as { payload: { observation: { observation_id: string } } }).payload
					.observation.observation_id,
		);
		expect(new Set(obsIds)).toEqual(new Set([HEX16_A, HEX16_B]));
	});

	it("two observations but ONE trace when spans share a trace_id (map dedup)", async () => {
		const traces: unknown[] = [];
		const observations: unknown[] = [];
		subscribe("trace.created", (m) => traces.push(m));
		subscribe("observation.created", (m) => observations.push(m));

		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify(
					validOtlp([
						{
							trace_id: HEX32_A,
							span_id: HEX16_A,
							name: "root",
							start_time_unix_nano: String(NOW_NS),
							attributes: [],
						},
						{
							trace_id: HEX32_A,
							span_id: HEX16_B,
							name: "child",
							start_time_unix_nano: String(NOW_NS + 500),
							attributes: [],
						},
					]),
				),
			}),
		);
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 5));

		expect(traces).toHaveLength(1);
		expect(observations).toHaveLength(2);
	});

	it("sends a typed, prompt-safe metadata envelope to the observation writer", async () => {
		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify(
					validOtlp([
						{
							trace_id: HEX32_A,
							span_id: HEX16_A,
							name: "generation",
							start_time_unix_nano: String(NOW_NS),
							attributes: [
								{
									key: "gen_ai.request.model",
									value: { stringValue: "gpt-4o" },
								},
								{
									key: "astraea.prompt.id",
									value: { stringValue: "support-agent" },
								},
								{ key: "astraea.prompt.version", value: { intValue: 7 } },
								{
									key: "astraea.prompt.content_hash",
									value: { stringValue: HASH },
								},
								{
									key: "astraea.prompt.source",
									value: { stringValue: "never persisted" },
								},
							],
						},
					]),
				),
			}),
		);
		expect(res.status).toBe(200);
		const inserted = insertObservations.mock.calls[0]?.[1] as Array<{
			metadata: unknown;
		}>;
		expect(inserted[0]?.metadata).toEqual({
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

	it("a throwing subscriber does NOT change the HTTP response", async () => {
		const orig = console.error;
		console.error = () => undefined;

		subscribe("trace.created", () => {
			throw new Error("subscriber boom");
		});
		subscribe("observation.created", () => {
			throw new Error("observation subscriber boom");
		});

		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify(
					validOtlp([
						{
							trace_id: HEX32_A,
							span_id: HEX16_A,
							name: "single",
							start_time_unix_nano: String(NOW_NS),
							attributes: [],
						},
					]),
				),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { partial_success: unknown };
		expect(body.partial_success).toEqual({});
		console.error = orig;
	});

	it("an insert failure does NOT publish events and returns 500", async () => {
		const traces: unknown[] = [];
		const observations: unknown[] = [];
		subscribe("trace.created", (m) => traces.push(m));
		subscribe("observation.created", (m) => observations.push(m));

		insertTraces.mockImplementationOnce(() =>
			Promise.reject(new Error("Connection refused: 10.0.0.1:8123")),
		);

		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify(
					validOtlp([
						{
							trace_id: HEX32_A,
							span_id: HEX16_A,
							name: "single",
							start_time_unix_nano: String(NOW_NS),
							attributes: [],
						},
					]),
				),
			}),
		);
		expect(res.status).toBe(500);
		expect(traces).toHaveLength(0);
		expect(observations).toHaveLength(0);
	});
});
