import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import protobufRoot from "@opentelemetry/otlp-proto-exporter-base/build/src/generated/root.js";
import { createOtlpIngestHandler } from "../../src/routes/otlp.js";

const tenant = {
	actorId: "11111111-1111-4111-8111-111111111111",
	organizationId: "22222222-2222-4222-8222-222222222222",
	projectId: "33333333-3333-4333-8333-333333333333",
};

test("OTLP JSON accepts an empty export and returns an empty OTLP response", async () => {
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => null,
		defaultClient: () => ({}) as never,
		insertTraces: async () => undefined,
		insertObservations: async () => undefined,
	});
	const response = await handler(
		new Request("http://localhost/v1/otel/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		}),
		tenant,
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({});
});

test("OTLP JSON accepts lower-camel OTLP fields, uppercase IDs, and gzip", async () => {
	let traces = 0;
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => null,
		defaultClient: () => ({}) as never,
		insertTraces: async (_client, rows) => {
			traces = rows.length;
		},
		insertObservations: async () => undefined,
	});
	const response = await handler(
		new Request("http://localhost/v1/otel/v1/traces", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-encoding": "gzip",
			},
			body: gzipSync(
				JSON.stringify({
					resourceSpans: [
						{
							scopeSpans: [
								{
									spans: [
										{
											traceId: "00112233445566778899AABBCCDDEEFF",
											spanId: "0011223344556677",
											name: "span",
											startTimeUnixNano: "1700000000000000000",
										},
									],
								},
							],
						},
					],
				}),
			),
		}),
		tenant,
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({});
	expect(traces).toBe(1);
});

test("OTLP protobuf accepts an empty official export and responds in protobuf", async () => {
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => null,
		defaultClient: () => ({}) as never,
		insertTraces: async () => undefined,
		insertObservations: async () => undefined,
	});
	const response = await handler(
		new Request("http://localhost/v1/otel/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/x-protobuf" },
			body: new Uint8Array(),
		}),
		tenant,
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("application/x-protobuf");
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(
		new Uint8Array(),
	);
});

test("OTLP protobuf persists root and child spans encoded by the official schema", async () => {
	let traceIds: string[] = [];
	let observations: Array<{
		observation_id: string;
		parent_observation_id: string | null;
	}> = [];
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => null,
		defaultClient: () => ({}) as never,
		insertTraces: async (_client, rows) => {
			traceIds = rows.map((row) => row.trace_id);
		},
		insertObservations: async (_client, rows) => {
			observations = rows.map((row) => ({
				observation_id: row.observation_id,
				parent_observation_id: row.parent_observation_id,
			}));
		},
	});
	const ExportTraceServiceRequest = (
		protobufRoot as unknown as {
			opentelemetry: {
				proto: {
					collector: { trace: { v1: { ExportTraceServiceRequest: never } } };
				};
			};
		}
	).opentelemetry.proto.collector.trace.v1
		.ExportTraceServiceRequest as unknown as {
		encode: (value: object) => { finish: () => Uint8Array };
	};
	const traceId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
	const rootSpanId = Buffer.from("0011223344556677", "hex");
	const body = ExportTraceServiceRequest.encode({
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: "agent" } },
					],
				},
				scopeSpans: [
					{
						spans: [
							{
								traceId,
								spanId: rootSpanId,
								name: "root",
								startTimeUnixNano: "1700000000000000000",
							},
							{
								traceId,
								spanId: Buffer.from("8899aabbccddeeff", "hex"),
								parentSpanId: rootSpanId,
								name: "child",
								startTimeUnixNano: "1700000000000000001",
							},
						],
					},
				],
			},
		],
	}).finish();
	const response = await handler(
		new Request("http://localhost/v1/otel/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/x-protobuf" },
			body,
		}),
		tenant,
	);
	expect(response.status).toBe(200);
	expect(traceIds).toEqual(["00112233445566778899aabbccddeeff"]);
	expect(observations).toEqual([
		{ observation_id: "0011223344556677", parent_observation_id: null },
		{
			observation_id: "8899aabbccddeeff",
			parent_observation_id: "0011223344556677",
		},
	]);
});

test("OTLP JSON rejects null resource spans without attempting persistence", async () => {
	let persisted = false;
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => null,
		defaultClient: () => ({}) as never,
		insertTraces: async () => {
			persisted = true;
		},
		insertObservations: async () => {
			persisted = true;
		},
	});
	const response = await handler(
		new Request("http://localhost/v1/otel/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ resourceSpans: [null] }),
		}),
		tenant,
	);
	expect(response.status).toBe(400);
	expect(persisted).toBe(false);
});

test("OTLP gzip exceeding the decompressed limit returns 413", async () => {
	const handler = createOtlpIngestHandler();
	const response = await handler(
		new Request("http://localhost/v1/otel/v1/traces", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-encoding": "gzip",
			},
			body: gzipSync("x".repeat(1_048_577)),
		}),
		tenant,
	);
	expect(response.status).toBe(413);
	expect(await response.json()).toEqual({
		message: "Trace export exceeds the request limit",
	});
});

test("OTLP errors use google.rpc.Status in the request encoding", async () => {
	const handler = createOtlpIngestHandler();
	const response = await handler(
		new Request("http://localhost/v1/otel/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/x-protobuf" },
			body: new Uint8Array([255]),
		}),
		tenant,
	);
	expect(response.status).toBe(400);
	expect(response.headers.get("content-type")).toBe("application/x-protobuf");
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(
		new Uint8Array([
			18,
			28,
			...new TextEncoder().encode("Invalid trace export request"),
		]),
	);
});

test("OTLP returns partial success instead of silently dropping event and link spans", async () => {
	let persisted: string[] = [];
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => null,
		defaultClient: () => ({}) as never,
		insertTraces: async (_client, rows) => {
			persisted = rows.map((row) => row.name);
		},
		insertObservations: async () => undefined,
	});
	const response = await handler(
		new Request("http://localhost/v1/otel/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				resourceSpans: [
					{
						scopeSpans: [
							{
								spans: [
									{
										traceId: "00112233445566778899aabbccddeeff",
										spanId: "0011223344556677",
										name: "retained",
										startTimeUnixNano: "1700000000000000000",
									},
									{
										traceId: "00112233445566778899aabbccddeeff",
										spanId: "8899aabbccddeeff",
										name: "rejected",
										startTimeUnixNano: "1700000000000000000",
										events: [{ name: "unretained" }],
									},
								],
							},
						],
					},
				],
			}),
		}),
		tenant,
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		partialSuccess: {
			rejectedSpans: "1",
			errorMessage: "Spans with events or links are not supported",
		},
	});
	expect(persisted).toEqual(["retained"]);
});
