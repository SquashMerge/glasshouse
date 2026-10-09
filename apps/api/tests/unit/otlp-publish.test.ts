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
import { TenantScopeError } from "../../src/tenancy";
import {
	MAX_RETAINED_METADATA_BYTES,
	MAX_RETAINED_TEXT_BYTES,
} from "../../src/db/trace-payload-bounds";

const insertTraces = mock(() => Promise.resolve());
const insertObservations = mock(() => Promise.resolve());
const defaultClient = mock(() => ({}));
const withActiveAuthorizedProjectLock = async <T>(
	_tenant: unknown,
	callback: () => Promise<T>,
) => callback();
const rawHandleOtlpIngest = createOtlpIngestHandler({
	defaultClient,
	insertObservations,
	insertTraces,
	publishSync,
	approvedRedaction: async () => null,
	withActiveAuthorizedProjectLock,
});

const USER = "glasshouse";
const PASS = "secret";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

const HEX32_A = "00112233445566778899aabbccddeeff";
const HEX32_B = "00112233445566778899aabbccddeefe";
const HEX16_A = "0011223344556677";
const HEX16_B = "0011223344556678";
const NOW_NS = 1_700_000_000_000_000_000;
const HASH = "a".repeat(64);
const TENANT = {
	organizationId: "00000000-0000-4000-8000-000000000010",
	projectId: "00000000-0000-4000-8000-000000000011",
};
const handleOtlpIngest = (request: Request, tenant = TENANT) =>
	rawHandleOtlpIngest(request, tenant);
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

beforeAll(() => {
	process.env.UI_USERNAME = USER;
	process.env.UI_PASSWORD = PASS;
});

beforeEach(() => {
	delete process.env.VALKEY_PUBSUB_URL;
	defaultClient.mockClear();
	insertTraces.mockClear();
	insertObservations.mockClear();
	_resetForTests();
});

function validOtlp(
	spans: Array<Record<string, unknown>>,
	resourceAttributes: Array<Record<string, unknown>> = [],
) {
	return {
		resource_spans: [
			{
				resource: { attributes: resourceAttributes },
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
	it("redacts before bounding the rows persisted and published from a large OTLP span", async () => {
		const secret = "secret-that-must-not-survive";
		const handler = createOtlpIngestHandler({
			defaultClient,
			insertObservations,
			insertTraces,
			publishSync,
			approvedRedaction: async () => ({
				mode: "all_text" as const,
				keys: ["private.attribute"],
			}),
			withActiveAuthorizedProjectLock,
		});
		const published: unknown[] = [];
		subscribe("observation.created", (event) => published.push(event));

		const response = await handler(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					validOtlp([
						{
							trace_id: HEX32_A,
							span_id: HEX16_A,
							name: "bounded",
							start_time_unix_nano: String(NOW_NS),
							attributes: [
								{
									key: "gen_ai.prompt.0.content",
									value: { stringValue: secret.repeat(2_000) },
								},
								{ key: "private.attribute", value: { stringValue: secret } },
								{
									key: "safe.attribute",
									value: { stringValue: "界".repeat(20_000) },
								},
							],
						},
					]),
				),
			}),
			TENANT,
		);

		expect(response.status).toBe(200);
		const trace = insertTraces.mock.calls.at(-1)?.[1]?.[0];
		const observation = insertObservations.mock.calls.at(-1)?.[1]?.[0];
		expect(trace.input_text).toBe("[REDACTED]");
		expect(observation.input_text).toBe("[REDACTED]");
		expect(JSON.stringify(observation.metadata)).not.toContain(secret);
		expect(
			new TextEncoder().encode(trace.output_text).byteLength,
		).toBeLessThanOrEqual(MAX_RETAINED_TEXT_BYTES);
		expect(
			new TextEncoder().encode(JSON.stringify(observation.metadata)).byteLength,
		).toBeLessThanOrEqual(MAX_RETAINED_METADATA_BYTES);
		expect(JSON.stringify(published)).not.toContain(secret);
	});

	it("does not invoke ClickHouse writers when final archive or revocation revalidation fails", async () => {
		for (const unavailable of ["archived", "revoked"]) {
			const rejectedHandler = createOtlpIngestHandler({
				defaultClient,
				insertObservations,
				insertTraces,
				publishSync,
				approvedRedaction: async () => null,
				withActiveAuthorizedProjectLock: async () => {
					throw new TenantScopeError(`Project is ${unavailable}`);
				},
			});
			insertTraces.mockClear();
			insertObservations.mockClear();

			await expect(
				rejectedHandler(
					new Request("http://x/v1/otel/v1/traces", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(
							validOtlp([
								{
									trace_id: HEX32_A,
									span_id: HEX16_A,
									name: "denied",
									start_time_unix_nano: String(NOW_NS),
									attributes: [],
								},
							]),
						),
					}),
					TENANT,
				),
			).rejects.toBeInstanceOf(TenantScopeError);
			expect(insertTraces, unavailable).not.toHaveBeenCalled();
			expect(insertObservations, unavailable).not.toHaveBeenCalled();
		}
	});

	it("propagates a resource project ID to traces and observations, not a span override", async () => {
		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify(
					validOtlp(
						[
							{
								trace_id: HEX32_A,
								span_id: HEX16_A,
								name: "project-scoped",
								start_time_unix_nano: String(NOW_NS),
								attributes: [
									{
										key: "glasshouse.project.id",
										value: { stringValue: OTHER_PROJECT_ID },
									},
								],
							},
						],
						[
							{
								key: "glasshouse.project.id",
								value: { stringValue: PROJECT_ID },
							},
						],
					),
				),
			}),
		);
		expect(res.status).toBe(200);
		const traces = insertTraces.mock.calls[0]?.[1] as Array<{
			project_id: string;
		}>;
		const observations = insertObservations.mock.calls[0]?.[1] as Array<{
			project_id: string;
		}>;
		expect(traces[0]?.project_id).toBe(PROJECT_ID);
		expect(observations[0]?.project_id).toBe(PROJECT_ID);
	});

	it("falls back to the resolved project when resource project IDs are missing or malformed", async () => {
		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify({
					resource_spans: [
						validOtlp([
							{
								trace_id: HEX32_A,
								span_id: HEX16_A,
								name: "span-only",
								start_time_unix_nano: String(NOW_NS),
								attributes: [
									{
										key: "glasshouse.project.id",
										value: { stringValue: PROJECT_ID },
									},
								],
							},
						]).resource_spans[0],
						validOtlp(
							[
								{
									trace_id: HEX32_B,
									span_id: HEX16_B,
									name: "malformed-resource",
									start_time_unix_nano: String(NOW_NS),
									attributes: [],
								},
							],
							[
								{
									key: "glasshouse.project.id",
									value: { stringValue: "not-a-project-id" },
								},
							],
						).resource_spans[0],
					],
				}),
			}),
		);
		expect(res.status).toBe(200);
		const traces = insertTraces.mock.calls[0]?.[1] as Array<{
			project_id: string;
		}>;
		const observations = insertObservations.mock.calls[0]?.[1] as Array<{
			project_id: string;
		}>;
		expect(traces.map((trace) => trace.project_id)).toEqual([
			TENANT.projectId,
			TENANT.projectId,
		]);
		expect(observations.map((observation) => observation.project_id)).toEqual([
			TENANT.projectId,
			TENANT.projectId,
		]);
	});

	it("rejects a trace split across scoped and unscoped resource spans before writes or events", async () => {
		const traces: unknown[] = [];
		const observations: unknown[] = [];
		subscribe("trace.created", (message) => traces.push(message));
		subscribe("observation.created", (message) => observations.push(message));

		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify({
					resource_spans: [
						validOtlp(
							[
								{
									trace_id: HEX32_A,
									span_id: HEX16_A,
									name: "scoped",
									start_time_unix_nano: String(NOW_NS),
									attributes: [],
								},
							],
							[
								{
									key: "glasshouse.project.id",
									value: { stringValue: PROJECT_ID },
								},
							],
						).resource_spans[0],
						validOtlp([
							{
								trace_id: HEX32_A,
								span_id: HEX16_B,
								name: "legacy",
								start_time_unix_nano: String(NOW_NS + 1),
								attributes: [],
							},
						]).resource_spans[0],
					],
				}),
			}),
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "BAD_REQUEST",
			message: "Trace contains conflicting project provenance",
		});
		expect(defaultClient).not.toHaveBeenCalled();
		expect(insertTraces).not.toHaveBeenCalled();
		expect(insertObservations).not.toHaveBeenCalled();
		expect(traces).toHaveLength(0);
		expect(observations).toHaveLength(0);
	});

	it("rejects a trace split across two scoped projects before writes or events", async () => {
		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify({
					resource_spans: [
						validOtlp(
							[
								{
									trace_id: HEX32_A,
									span_id: HEX16_A,
									name: "project-a",
									start_time_unix_nano: String(NOW_NS),
									attributes: [],
								},
							],
							[
								{
									key: "glasshouse.project.id",
									value: { stringValue: PROJECT_ID },
								},
							],
						).resource_spans[0],
						validOtlp(
							[
								{
									trace_id: HEX32_A,
									span_id: HEX16_B,
									name: "project-b",
									start_time_unix_nano: String(NOW_NS + 1),
									attributes: [],
								},
							],
							[
								{
									key: "glasshouse.project.id",
									value: { stringValue: OTHER_PROJECT_ID },
								},
							],
						).resource_spans[0],
					],
				}),
			}),
		);

		expect(res.status).toBe(400);
		expect(defaultClient).not.toHaveBeenCalled();
		expect(insertTraces).not.toHaveBeenCalled();
		expect(insertObservations).not.toHaveBeenCalled();
	});

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

	it("persists the authenticated organization with the resource project", async () => {
		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify(
					validOtlp(
						[
							{
								trace_id: HEX32_A,
								span_id: HEX16_A,
								name: "tenant-bound",
								start_time_unix_nano: String(NOW_NS),
								attributes: [
									{
										key: "glasshouse.organization_id",
										value: {
											stringValue: "00000000-0000-4000-8000-000000000099",
										},
									},
								],
							},
						],
						[
							{
								key: "glasshouse.project.id",
								value: { stringValue: PROJECT_ID },
							},
						],
					),
				),
			}),
			TENANT,
		);
		expect(res.status).toBe(200);
		expect(insertTraces.mock.calls[0]?.[1]).toMatchObject([
			{
				organization_id: TENANT.organizationId,
				project_id: PROJECT_ID,
			},
		]);
		expect(insertObservations.mock.calls[0]?.[1]).toMatchObject([
			{
				organization_id: TENANT.organizationId,
				project_id: PROJECT_ID,
			},
		]);
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

	it("uses the root identity and aggregates timing and error status across spans", async () => {
		const res = await handleOtlpIngest(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: JSON.stringify(
					validOtlp([
						{
							trace_id: HEX32_A,
							span_id: HEX16_B,
							parent_span_id: HEX16_A,
							name: "child error",
							start_time_unix_nano: String(NOW_NS + 1_000_000),
							end_time_unix_nano: String(NOW_NS + 10_000_000),
							status: { code: 2 },
							attributes: [],
						},
						{
							trace_id: HEX32_A,
							span_id: HEX16_A,
							name: "root request",
							start_time_unix_nano: String(NOW_NS),
							end_time_unix_nano: String(NOW_NS + 5_000_000),
							attributes: [],
						},
					]),
				),
			}),
		);
		expect(res.status).toBe(200);
		const inserted = insertTraces.mock.calls[0]?.[1] as Array<{
			name: string;
			status: string;
			duration_ms: number | null;
		}>;
		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({
			name: "root request",
			status: "error",
			duration_ms: 9,
		});
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
									key: "glasshouse.prompt.id",
									value: { stringValue: "support-agent" },
								},
								{ key: "glasshouse.prompt.version", value: { intValue: 7 } },
								{
									key: "glasshouse.prompt.content_hash",
									value: { stringValue: HASH },
								},
								{
									key: "glasshouse.prompt.source",
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

	it("redacts configured identity keys before persistence and event normalization", async () => {
		const secret = "UNIQUE_GOVERNANCE_ENDUSER_SECRET";
		const traces: unknown[] = [];
		const observations: unknown[] = [];
		subscribe("trace.created", (message) => traces.push(message));
		subscribe("observation.created", (message) => observations.push(message));
		const redactedHandler = createOtlpIngestHandler({
			defaultClient,
			insertObservations,
			insertTraces,
			publishSync,
			approvedRedaction: async () => ({
				mode: "all_text",
				keys: ["enduser.id"],
			}),
			withActiveAuthorizedProjectLock,
		});

		const res = await redactedHandler(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(
					validOtlp([
						{
							trace_id: HEX32_A,
							span_id: HEX16_A,
							name: "redacted",
							start_time_unix_nano: String(NOW_NS),
							attributes: [
								{ key: "enduser.id", value: { stringValue: secret } },
								{
									key: "gen_ai.prompt.0.content",
									value: { stringValue: secret },
								},
								{
									key: "gen_ai.completion.0.content",
									value: { stringValue: secret },
								},
								{ key: "input.value", value: { stringValue: secret } },
								{ key: "output.value", value: { stringValue: secret } },
							],
						},
					]),
				),
			}),
			TENANT,
		);
		expect(res.status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const persisted = JSON.stringify({
			traces: insertTraces.mock.calls.at(-1)?.[1],
			observations: insertObservations.mock.calls.at(-1)?.[1],
			events: [...traces, ...observations],
		});
		expect(persisted).not.toContain(secret);
		expect(persisted).toContain("[REDACTED]");
		expect(insertTraces.mock.calls.at(-1)?.[1]?.[0]?.user_id).toBe("");
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

	it("deduplicates a retry after traces persist but observations fail", async () => {
		const persistedTraces: Array<{ trace_id: string }> = [];
		const persistedObservations: Array<{ observation_id: string }> = [];
		const traceTokens = new Set<string>();
		const observationTokens = new Set<string>();
		let failObservations = true;
		const retryHandler = createOtlpIngestHandler({
			defaultClient: () => ({}),
			insertTraces: async (_client, traces, token) => {
				expect(token).toMatch(/^glasshouse:otlp:traces:[0-9a-f]{64}$/);
				if (!traceTokens.has(token)) persistedTraces.push(...traces);
				traceTokens.add(token);
			},
			insertObservations: async (_client, observations, token) => {
				expect(token).toMatch(/^glasshouse:otlp:observations:[0-9a-f]{64}$/);
				if (failObservations) {
					failObservations = false;
					throw new Error("simulated observation insert failure");
				}
				if (!observationTokens.has(token))
					persistedObservations.push(...observations);
				observationTokens.add(token);
			},
			publishSync,
			approvedRedaction: async () => null,
			withActiveAuthorizedProjectLock,
		});
		const payload = validOtlp([
			{
				trace_id: HEX32_A,
				span_id: HEX16_A,
				name: "retry-safe",
				start_time_unix_nano: String(NOW_NS),
				attributes: [],
			},
		]);
		const retry = () =>
			retryHandler(
				new Request("http://x/v1/otel/v1/traces", {
					method: "POST",
					headers: { authorization: AUTH, "content-type": "application/json" },
					body: JSON.stringify(payload),
				}),
				TENANT,
			);

		expect((await retry()).status).toBe(500);
		expect((await retry()).status).toBe(200);
		expect(persistedTraces).toHaveLength(1);
		expect(persistedObservations).toHaveLength(1);
		expect(traceTokens).toHaveLength(1);
		expect(observationTokens).toHaveLength(1);
		expect([...traceTokens][0]).not.toBe([...observationTokens][0]);
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
