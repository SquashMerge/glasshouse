import { afterEach, beforeEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import protobufRoot from "@opentelemetry/otlp-proto-exporter-base/build/src/generated/root.js";
import {
	createOtlpIngestHandler,
	type OtlpIngestDependencies,
} from "../../src/routes/otlp.js";

const tenant = {
	organizationId: "22222222-2222-4222-8222-222222222222",
	projectId: "33333333-3333-4333-8333-333333333333",
};
const originalEnv = {
	GLASSHOUSE_REDACT_INPUT: process.env.GLASSHOUSE_REDACT_INPUT,
	GLASSHOUSE_REDACT_KEYS: process.env.GLASSHOUSE_REDACT_KEYS,
};
beforeEach(() => {
	delete process.env.GLASSHOUSE_REDACT_INPUT;
	delete process.env.GLASSHOUSE_REDACT_KEYS;
});
afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function payload(input = "synthetic-private-input") {
	return {
		resourceSpans: [
			{
				scopeSpans: [
					{
						spans: [
							{
								traceId: "00112233445566778899aabbccddeeff",
								spanId: "0011223344556677",
								name: "retry-identity",
								startTimeUnixNano: "1700000000000000000",
								attributes: [
									{
										key: "gen_ai.prompt.0.content",
										value: { stringValue: input },
									},
									{
										key: "enduser.id",
										value: { stringValue: "synthetic-user" },
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

function protobuf(input?: string) {
	const value = payload(input);
	const span = value.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
	const exporter = (
		protobufRoot as unknown as {
			opentelemetry: {
				proto: {
					collector: {
						trace: {
							v1: {
								ExportTraceServiceRequest: {
									encode: (value: object) => { finish: () => Uint8Array };
								};
							};
						};
					};
				};
			};
		}
	).opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
	return exporter
		.encode({
			resourceSpans: [
				{
					scopeSpans: [
						{
							spans: [
								{
									...span,
									traceId: Buffer.from(span.traceId, "hex"),
									spanId: Buffer.from(span.spanId, "hex"),
								},
							],
						},
					],
				},
			],
		})
		.finish();
}

function request(
	body: string | Uint8Array,
	contentType = "application/json",
	gzip = false,
) {
	return new Request("http://localhost/v1/traces", {
		method: "POST",
		headers: {
			"content-type": contentType,
			...(gzip ? { "content-encoding": "gzip" } : {}),
		},
		body: gzip ? gzipSync(body) : body,
	});
}

function capture(overrides: Partial<OtlpIngestDependencies> = {}) {
	const tokens: string[] = [];
	const rows: unknown[] = [];
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => ({ mode: "all_text", keys: ["enduser.id"] }),
		defaultClient: () => ({}) as never,
		insertTraces: async (_client, values, token) => {
			tokens.push(token);
			rows.push(values);
		},
		insertObservations: async () => undefined,
		publishSync: () => undefined,
		...overrides,
	});
	return { handler, tokens, rows };
}

for (const encoding of ["json", "protobuf"] as const) {
	test(`${encoding} retry keeps both tokens after trace commit, observation timeout, and policy change`, async () => {
		let policy: Awaited<
			ReturnType<OtlpIngestDependencies["approvedRedaction"]>
		> = { mode: "none", keys: [] };
		const traceTokens: string[] = [];
		const observationTokens: string[] = [];
		const committed = new Map<string, unknown>();
		const attemptedRows: unknown[] = [];
		const observations: unknown[] = [];
		const events: unknown[] = [];
		const { handler } = capture({
			approvedRedaction: async () => policy,
			insertTraces: async (_client, rows, token) => {
				traceTokens.push(token);
				attemptedRows.push(rows);
				if (!committed.has(token)) committed.set(token, rows);
			},
			insertObservations: async (_client, rows, token) => {
				observationTokens.push(token);
				if (observationTokens.length === 1)
					throw Object.assign(new Error("synthetic observation timeout"), {
						code: "ETIMEDOUT",
					});
				observations.push(rows);
			},
			publishSync: (event, data) => {
				events.push({ event, data });
			},
		});
		const body = encoding === "json" ? JSON.stringify(payload()) : protobuf();
		const type =
			encoding === "json" ? "application/json" : "application/x-protobuf";
		const first = await handler(request(body, type), tenant);
		expect(first.status).toBe(503);
		expect(events).toHaveLength(0);
		expect(committed.size).toBe(1);
		policy = { mode: "all_text", keys: ["enduser.id"] };
		expect((await handler(request(body, type), tenant)).status).toBe(200);
		expect(attemptedRows[0]).not.toEqual(attemptedRows[1]);
		expect(JSON.stringify(attemptedRows[1])).not.toContain(
			"synthetic-private-input",
		);
		expect(JSON.stringify(observations)).not.toContain(
			"synthetic-private-input",
		);
		expect(JSON.stringify(events)).not.toContain("synthetic-private-input");
		expect(traceTokens[1]).toBe(traceTokens[0]);
		expect(observationTokens[1]).toBe(observationTokens[0]);
		expect(traceTokens[0]).not.toBe(observationTokens[0]);
		expect(committed.size).toBe(1);
	});
}

test("different original JSON requests never share identity just because retained rows match", async () => {
	const { handler, tokens, rows } = capture();
	const body = JSON.stringify(payload());
	const inputs = [
		body,
		JSON.stringify(payload("different-redacted-input")),
		`${body} `,
		JSON.stringify({ ...payload(), futureExtension: "ignored-but-different" }),
		JSON.stringify({ ...payload(), futureExtension: null }),
	];
	for (const input of inputs)
		expect((await handler(request(input), tenant)).status).toBe(200);
	for (const row of rows) expect(row).toEqual(rows[0]);
	expect(new Set(tokens).size).toBe(inputs.length);
});

test("trace handler rejects an overlong unknown varint without writing a valid preceding span", async () => {
	let observations = 0;
	let events = 0;
	const { handler, rows } = capture({
		insertObservations: async () => {
			observations++;
		},
		publishSync: () => {
			events++;
		},
	});
	const body = Buffer.concat([
		protobuf(),
		Buffer.from(`a006${"80".repeat(10)}00`, "hex"),
	]);
	const response = await handler(
		request(body, "application/x-protobuf"),
		tenant,
	);
	expect(response.status).toBe(400);
	expect(rows).toHaveLength(0);
	expect(observations).toBe(0);
	expect(events).toBe(0);
});

test("trace handler rejects a mismatched group without writing a valid preceding span", async () => {
	let observations = 0;
	let events = 0;
	const { handler, rows } = capture({
		insertObservations: async () => {
			observations++;
		},
		publishSync: () => {
			events++;
		},
	});
	const body = Buffer.concat([protobuf(), Buffer.from("0b14", "hex")]);
	const response = await handler(
		request(body, "application/x-protobuf"),
		tenant,
	);
	expect(response.status).toBe(400);
	expect(rows).toHaveLength(0);
	expect(observations).toBe(0);
	expect(events).toBe(0);
});

test("different original protobuf requests include ignored wire fields in identity", async () => {
	const { handler, tokens, rows } = capture();
	const body = protobuf();
	for (const input of [
		body,
		protobuf("different-redacted-input"),
		Buffer.concat([body, Buffer.from([0xa0, 0x06, 0x01])]),
	])
		expect(
			(await handler(request(input, "application/x-protobuf"), tenant)).status,
		).toBe(200);
	for (const row of rows) expect(row).toEqual(rows[0]);
	expect(new Set(tokens).size).toBe(3);
});

test("retention clipping cannot merge different original text", async () => {
	const { handler, tokens, rows } = capture({
		approvedRedaction: async () => null,
	});
	for (const suffix of ["first", "second"])
		expect(
			(
				await handler(
					request(JSON.stringify(payload("x".repeat(10_000) + suffix))),
					tenant,
				)
			).status,
		).toBe(200);
	expect(rows[0]).toEqual(rows[1]);
	expect(tokens[0]).not.toBe(tokens[1]);
});

test("compression and protobuf media aliases preserve byte identity, JSON and protobuf stay distinct", async () => {
	const { handler, tokens, rows } = capture();
	const json = JSON.stringify(payload());
	const proto = protobuf();
	for (const req of [
		request(json),
		request(json, "Application/JSON; charset=utf-8", true),
		request(proto, "application/x-protobuf"),
		request(proto, "application/protobuf", true),
	])
		expect((await handler(req, tenant)).status).toBe(200);
	for (const row of rows) expect(row).toEqual(rows[0]);
	expect(tokens[0]).toBe(tokens[1]);
	expect(tokens[2]).toBe(tokens[3]);
	expect(tokens[0]).not.toBe(tokens[2]);
});

test("identical bytes remain isolated by trusted organization and Project", async () => {
	const { handler, tokens } = capture();
	const body = JSON.stringify(payload());
	for (const scope of [
		tenant,
		{ ...tenant, organizationId: "44444444-4444-4444-8444-444444444444" },
		{ ...tenant, projectId: "55555555-5555-4555-8555-555555555555" },
	])
		expect((await handler(request(body), scope)).status).toBe(200);
	expect(new Set(tokens).size).toBe(3);
});
