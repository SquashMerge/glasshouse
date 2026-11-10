import { expect, test } from "bun:test";
import type {
	TenantScopedObservation,
	TenantScopedTrace,
} from "../../src/db/traces-writer.js";
import { createOtlpIngestHandler } from "../../src/routes/otlp.js";

const tenant = {
	actorId: "11111111-1111-4111-8111-111111111111",
	organizationId: "22222222-2222-4222-8222-222222222222",
	projectId: "33333333-3333-4333-8333-333333333333",
};
const attr = (key: string, text: string) => ({
	key,
	value: { stringValue: text },
});
const start = "1700000000000999999";

test("malformed AnyValue oneofs reject the trace before persistence", async () => {
	for (const value of [
		{ stringValue: "a", boolValue: false },
		{ arrayValue: { values: [{ intValue: "1", stringValue: "a" }] } },
		{
			kvlistValue: {
				values: [
					{ key: "nested", value: { stringValue: "a", boolValue: true } },
				],
			},
		},
	]) {
		const h = harness();
		const payload = body();
		const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
		(span.attributes as unknown[]) = [{ key: "invalid", value }];
		expect((await h.post(payload)).status).toBe(400);
		expect(h.observations).toHaveLength(0);
		expect(h.traces).toHaveLength(0);
	}
});

test("quoted finite AnyValue doubles survive trace ingestion", async () => {
	const h = harness();
	const payload = body();
	const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
	(span.attributes as unknown[]) = [
		{ key: "measurement", value: { doubleValue: "-1.25e2" } },
	];
	expect((await h.post(payload)).status).toBe(200);
	expect(JSON.stringify(h.observations)).toContain('"doubleValue":-125');
});

test("invalid quoted doubles reject traces and null oneof alternatives stay unset", async () => {
	for (const invalid of [
		"",
		" ",
		"0x10",
		"nan",
		"1e9999",
		"1e",
		"1".repeat(129),
	]) {
		const h = harness();
		const payload = body();
		const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
		(span.attributes as unknown[]) = [
			{ key: "invalid", value: { doubleValue: invalid } },
		];
		expect((await h.post(payload)).status).toBe(400);
		expect(h.observations).toHaveLength(0);
	}
	const h = harness();
	const payload = body();
	const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
	(span.attributes as unknown[]) = [
		{ key: "valid", value: { doubleValue: "0.5", stringValue: null } },
	];
	expect((await h.post(payload)).status).toBe(200);
	expect(JSON.stringify(h.observations)).toContain('"doubleValue":0.5');
});
function body() {
	return {
		resourceSpans: [
			{
				schemaUrl: "resource-schema",
				resource: {
					attributes: [
						attr("service.name", "synthetic"),
						{ key: "created", value: { intValue: start } },
					],
					droppedAttributesCount: 3,
				},
				scopeSpans: [
					{
						schemaUrl: "scope-schema",
						scope: {
							name: "instrumentation",
							version: "1.2",
							attributes: [attr("scope.attribute", "value")],
							droppedAttributesCount: 4,
						},
						spans: [
							{
								traceId: "00112233445566778899aabbccddeeff",
								spanId: "0011223344556677",
								name: "root",
								startTimeUnixNano: start,
								endTimeUnixNano: "1700000000001000001",
								traceState: "vendor=state",
								flags: 769,
								kind: 2,
								droppedAttributesCount: 5,
								droppedEventsCount: 6,
								droppedLinksCount: 7,
								status: { code: 2, message: "exception-message" },
								attributes: [attr("span.attribute", "value")],
								events: [
									{
										name: "exception",
										timeUnixNano: "1700000000001000000",
										droppedAttributesCount: 8,
										attributes: [
											attr("exception.type", "ValueError"),
											attr("exception.message", "exception-message"),
											attr("exception.stacktrace", "synthetic-stack"),
										],
									},
								],
								links: [
									{
										traceId: "FFEEDDCCBBAA99887766554433221100",
										spanId: "7766554433221100",
										traceState: "vendor=link",
										flags: 513,
										droppedAttributesCount: 9,
										attributes: [attr("link.attribute", "value")],
									},
								],
							},
						],
					},
				],
			},
		],
	};
}
function harness(
	policy: { mode: "none" | "all_text"; keys: string[] } = {
		mode: "none",
		keys: [],
	},
) {
	const observations: TenantScopedObservation[] = [];
	const traces: TenantScopedTrace[] = [];
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_, run) => run({} as never),
		approvedRedaction: async () => policy as never,
		defaultClient: () => ({}) as never,
		insertTraces: async (_, rows) => {
			traces.push(...rows);
		},
		insertObservations: async (_, rows) => {
			observations.push(...rows);
		},
		publishSync: () => undefined,
	});
	return {
		observations,
		traces,
		post: (payload: unknown) =>
			handler(
				new Request("http://localhost/v1/traces", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				}),
				tenant,
			),
	};
}

test("event/link spans retain exact nanos, context, status and dropped counts", async () => {
	const h = harness();
	const response = await h.post(body());
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({});
	expect(h.observations).toHaveLength(1);
	expect(h.observations[0]).toMatchObject({
		start_time_unix_nano: start,
		end_time_unix_nano: "1700000000001000001",
		duration_nano: "2",
		duration_ms: 0.000002,
		otlp: {
			schema_version: 1,
			resource_schema_url: "resource-schema",
			scope_schema_url: "scope-schema",
			resource: { dropped_attributes_count: 3 },
			scope: { name: "instrumentation", dropped_attributes_count: 4 },
			kind: 2,
			flags: 769,
			trace_state: "vendor=state",
			dropped_attributes_count: 5,
			dropped_events_count: 6,
			dropped_links_count: 7,
			status: { code: 2, message: "exception-message" },
			events: [
				{
					name: "exception",
					time_unix_nano: "1700000000001000000",
					dropped_attributes_count: 8,
				},
			],
			links: [
				{
					trace_id: "ffeeddccbbaa99887766554433221100",
					span_id: "7766554433221100",
					flags: 513,
					dropped_attributes_count: 9,
				},
			],
		},
	});
	expect(h.traces[0]).toMatchObject({
		start_time_unix_nano: start,
		duration_nano: "2",
	});
});

for (const invalid of [
	"-1",
	"18446744073709551616",
	"1.2",
	"NaN",
	"",
	"1e18",
	1700000000000000000,
	-1,
	1.2,
]) {
	test(`invalid/unsafe timestamp ${JSON.stringify(invalid)} fails before persistence`, async () => {
		const h = harness();
		const payload = body();
		(
			payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]! as Record<
				string,
				unknown
			>
		).startTimeUnixNano = invalid;
		expect((await h.post(payload)).status).toBe(400);
		expect(h.observations).toHaveLength(0);
	});
}

test("all_text and recursive key redaction cover every retained telemetry string", async () => {
	const h = harness({ mode: "all_text", keys: ["secret"] });
	const payload = body();
	const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
	span.events[0]!.attributes.push(attr("secret", "never-retain"));
	span.links[0]!.attributes.push(attr("nested", "never-retain"));
	expect((await h.post(payload)).status).toBe(200);
	expect(h.observations).toHaveLength(1);
	const stored = JSON.stringify(h.observations);
	for (const secret of [
		"never-retain",
		"exception-message",
		"synthetic-stack",
		"vendor=state",
		"vendor=link",
		"resource-schema",
		"scope-schema",
		"instrumentation",
	])
		expect(stored).not.toContain(secret);
	expect(stored).toContain("[REDACTED]");
	expect(stored).toContain(start);
});

for (const modelAttribute of [false, true]) {
	test(`all_text retains safe typed provenance and OpenInference classification (model attribute=${modelAttribute})`, async () => {
		const h = harness({ mode: "all_text", keys: [] });
		const payload = body();
		const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
		(span.attributes as unknown[]) = [
			attr("openinference.span.kind", "LLM"),
			...(modelAttribute ? [attr("gen_ai.request.model", "secret-model")] : []),
			attr("glasshouse.prompt.id", "support-agent"),
			{ key: "glasshouse.prompt.version", value: { intValue: "7" } },
			attr("glasshouse.prompt.content_hash", "a".repeat(64)),
			attr("glasshouse.prompt.source", "never-retain-source"),
			attr("input.value", "never-retain-input"),
		];
		expect((await h.post(payload)).status).toBe(200);
		expect(h.observations[0]?.type).toBe("generation");
		expect(h.observations[0]?.metadata.prompt_provenance).toEqual({
			id: "support-agent",
			version: 7,
			content_hash: "a".repeat(64),
		});
		for (const secret of ["never-retain", "secret-model", "glasshouse.prompt."])
			expect(JSON.stringify([h.traces, h.observations])).not.toContain(secret);
	});
}

test("all_text structural exemptions honor configured keys and fail closed on malformed or duplicate provenance", async () => {
	for (const variant of [
		"key",
		"extension",
		"value-extension",
		"duplicate",
		"invalid",
		"unknown-kind",
	] as const) {
		const h = harness({
			mode: "all_text",
			keys:
				variant === "key"
					? ["glasshouse.prompt.id", "openinference.span.kind"]
					: [],
		});
		const payload = body();
		const attributes: unknown[] = [
			attr(
				"openinference.span.kind",
				variant === "unknown-kind" ? "never-retain-kind" : "LLM",
			),
			attr("glasshouse.prompt.id", "support-agent"),
			{ key: "glasshouse.prompt.version", value: { intValue: "7" } },
			attr("glasshouse.prompt.content_hash", "a".repeat(64)),
		];
		if (variant === "extension" || variant === "duplicate") {
			const malformed = {
				...attr("glasshouse.prompt.id", "never-retain-id"),
				futureExtension: "never-retain-extension",
			};
			if (variant === "extension") attributes[1] = malformed;
			else attributes.push(malformed);
		}
		if (variant === "invalid")
			attributes[1] = attr("glasshouse.prompt.id", "never-retain invalid id");
		if (variant === "value-extension")
			attributes[1] = {
				key: "glasshouse.prompt.id",
				value: {
					stringValue: "support-agent",
					futureExtension: "never-retain-extension",
				},
			};
		(payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
			.attributes as unknown[]) = attributes;
		expect((await h.post(payload)).status).toBe(200);
		expect(h.observations[0]?.metadata.prompt_provenance).toBeNull();
		expect(h.observations[0]?.type).toBe(
			variant === "key" || variant === "unknown-kind" ? "span" : "generation",
		);
		expect(JSON.stringify([h.traces, h.observations])).not.toContain(
			"never-retain",
		);
	}
});

test("oversized detail truncates honestly without dropping the span", async () => {
	const h = harness();
	const payload = body();
	payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.events[0]!.attributes.push(
		attr("large", "界".repeat(40_000)),
	);
	expect((await h.post(payload)).status).toBe(200);
	expect(h.observations).toHaveLength(1);
	const detail = (
		h.observations[0] as unknown as { otlp: { truncated?: boolean } }
	).otlp;
	expect(detail.truncated).toBe(true);
	expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(32_768);
});

test("null known fields are unset and event uint64 maximum is exact", async () => {
	const h = harness();
	const payload = body();
	const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
	Object.assign(span, { status: null, flags: null, endTimeUnixNano: null });
	span.events[0]!.timeUnixNano = "18446744073709551615";
	expect((await h.post(payload)).status).toBe(200);
	expect(h.observations[0]).toMatchObject({
		end_time_unix_nano: null,
		duration_nano: null,
		otlp: { events: [{ time_unix_nano: "18446744073709551615" }] },
	});
});

test("invalid event uint64, counts, links and unsafe attribute integers fail closed", async () => {
	for (const patch of [
		{ events: [{ name: "bad", timeUnixNano: "18446744073709551616" }] },
		{ events: [null] },
		{ droppedEventsCount: -1 },
		{ flags: 4_294_967_296 },
		{ links: [{ traceId: "invalid", spanId: "invalid" }] },
		{
			attributes: [
				{ key: "created", value: { intValue: 1700000000000999999 } },
			],
		},
		{ startTimeUnixNano: "18446744073709551615" },
		{ events: Array.from({ length: 513 }, () => ({ name: "excess" })) },
	]) {
		const h = harness();
		const payload = body();
		Object.assign(payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!, patch);
		expect((await h.post(payload)).status).toBe(400);
		expect(h.observations).toHaveLength(0);
	}
});

test("protobuf JSON special doubles survive and key redaction reaches nested event/link/scope/resource values", async () => {
	const h = harness({ mode: "none", keys: ["secret"] });
	const payload = body();
	const nested = {
		key: "nested",
		value: {
			arrayValue: {
				values: [
					{
						kvlistValue: {
							values: [
								attr("secret", "never-retain"),
								attr("safe", "retained"),
							],
						},
					},
				],
			},
		},
	};
	const resource = payload.resourceSpans[0]!;
	const scope = resource.scopeSpans[0]!;
	const span = scope.spans[0]!;
	for (const record of [
		resource.resource,
		scope.scope,
		span,
		span.events[0]!,
		span.links[0]!,
	])
		(record.attributes as unknown[]).push(nested);
	(span.attributes as unknown[]).push({
		key: "special",
		value: { doubleValue: "NaN" },
	});
	expect((await h.post(payload)).status).toBe(200);
	expect(JSON.stringify(h.observations)).not.toContain("never-retain");
	expect(JSON.stringify(h.observations)).toContain("retained");
	expect(JSON.stringify(h.observations)).toContain('"doubleValue":"NaN"');
});

test("OTLP detail cannot bypass the reserved prompt namespace stripping contract", async () => {
	const h = harness();
	const payload = body();
	const resource = payload.resourceSpans[0]!;
	const scope = resource.scopeSpans[0]!;
	const span = scope.spans[0]!;
	for (const record of [
		resource.resource,
		scope.scope,
		span,
		span.events[0]!,
		span.links[0]!,
	])
		record.attributes.push(
			attr("glasshouse.prompt.source", "never-retain-source"),
		);
	expect((await h.post(payload)).status).toBe(200);
	expect(JSON.stringify(h.observations)).not.toContain("never-retain-source");
});

test("repeated resource context cannot exceed the export-wide retention budget", async () => {
	const h = harness();
	const payload = body();
	payload.resourceSpans[0]!.resource.attributes.push(
		...Array.from({ length: 4 }, (_, index) =>
			attr(`large.${index}`, "x".repeat(8_192)),
		),
	);
	const scope = payload.resourceSpans[0]!.scopeSpans[0]!;
	const span = scope.spans[0]!;
	scope.spans = Array.from({ length: 300 }, (_, index) => ({
		...span,
		spanId: (index + 1).toString(16).padStart(16, "0"),
	}));
	expect((await h.post(payload)).status).toBe(200);
	expect(h.observations).toHaveLength(300);
	const bytes = h.observations.reduce(
		(total, observation) =>
			total + Buffer.byteLength(JSON.stringify(observation.otlp)),
		0,
	);
	expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
	expect(h.observations.at(-1)?.otlp?.truncated).toBe(true);
});

test("inverted source intervals reject before persistence rather than inventing a zero duration", async () => {
	const h = harness();
	const payload = body();
	payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.endTimeUnixNano = (
		BigInt(start) - 1n
	).toString();
	expect((await h.post(payload)).status).toBe(400);
	expect(h.observations).toHaveLength(0);
});
