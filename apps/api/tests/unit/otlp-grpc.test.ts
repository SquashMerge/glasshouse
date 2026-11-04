import { expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { createServer } from "node:net";
import protobufRoot from "@opentelemetry/otlp-proto-exporter-base/build/src/generated/root.js";
import { startOtlpGrpcServer } from "../../src/lib/otlp-grpc.js";
import { createOtlpIngestHandler } from "../../src/routes/otlp.js";

const traceExportPath =
	"/opentelemetry.proto.collector.trace.v1.TraceService/Export";
const healthPath = "/grpc.health.v1.Health/Check";

async function unusedLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Could not allocate a loopback port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

function unary(
	client: grpc.Client,
	path: string,
	payload: Buffer,
	metadata = new grpc.Metadata(),
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		client.makeUnaryRequest(
			path,
			(value: Buffer) => value,
			(value: Buffer) => value,
			payload,
			metadata,
			(error, response) => (error ? reject(error) : resolve(response)),
		);
	});
}

test("OTLP gRPC forwards and normalizes the original protobuf request", async () => {
	const port = await unusedLoopbackPort();
	const previousPort = process.env.OTLP_GRPC_PORT;
	const previousHost = process.env.OTLP_GRPC_HOST;
	process.env.OTLP_GRPC_PORT = String(port);
	process.env.OTLP_GRPC_HOST = "127.0.0.1";
	let forwarded: Request | undefined;
	let observationMetadata: unknown;
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => null,
		defaultClient: () => ({}) as never,
		insertTraces: async () => undefined,
		insertObservations: async (_client, rows) => {
			observationMetadata = rows[0]?.metadata;
		},
	});
	const stop = await startOtlpGrpcServer(async (request) => {
		forwarded = request.clone();
		return handler(request, {
			actorId: "11111111-1111-4111-8111-111111111111",
			organizationId: "22222222-2222-4222-8222-222222222222",
			projectId: "33333333-3333-4333-8333-333333333333",
		});
	});
	const client = new grpc.Client(
		`127.0.0.1:${port}`,
		grpc.credentials.createInsecure(),
	);
	try {
		const metadata = new grpc.Metadata();
		metadata.set("authorization", "Bearer test-token");
		metadata.set(
			"x-glasshouse-project-id",
			"33333333-3333-4333-8333-333333333333",
		);
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
		const payload = Buffer.from(
			ExportTraceServiceRequest.encode({
				resourceSpans: [
					{
						scopeSpans: [
							{
								spans: [
									{
										traceId: Buffer.from(
											"00112233445566778899aabbccddeeff",
											"hex",
										),
										spanId: Buffer.from("0011223344556677", "hex"),
										parentSpanId: Buffer.alloc(0),
										name: "grpc",
										startTimeUnixNano: "1700000000000000000",
										attributes: [
											{
												key: "binary",
												value: { bytesValue: Buffer.from("hello") },
											},
										],
									},
								],
							},
						],
					},
				],
			}).finish(),
		);
		expect(await unary(client, traceExportPath, payload, metadata)).toEqual(
			Buffer.alloc(0),
		);
		expect(forwarded?.headers.get("content-type")).toBe(
			"application/x-protobuf",
		);
		expect(new Uint8Array(await forwarded!.arrayBuffer())).toEqual(payload);
		expect(observationMetadata).toMatchObject({
			attributes: [{ key: "binary", value: { bytesValue: "aGVsbG8=" } }],
		});
		expect(await unary(client, healthPath, Buffer.alloc(0))).toEqual(
			Buffer.from([8, 1]),
		);
	} finally {
		client.close();
		await stop?.();
		if (previousPort === undefined) delete process.env.OTLP_GRPC_PORT;
		else process.env.OTLP_GRPC_PORT = previousPort;
		if (previousHost === undefined) delete process.env.OTLP_GRPC_HOST;
		else process.env.OTLP_GRPC_HOST = previousHost;
	}
});

test("OTLP gRPC rejects public and malformed bind hosts", async () => {
	const previousPort = process.env.OTLP_GRPC_PORT;
	const previousHost = process.env.OTLP_GRPC_HOST;
	process.env.OTLP_GRPC_PORT = "4317";
	process.env.OTLP_GRPC_HOST = "127.0.0.1.evil.example";
	try {
		await expect(startOtlpGrpcServer(() => new Response())).rejects.toThrow(
			"OTLP_GRPC_HOST must be a loopback or private address",
		);
	} finally {
		if (previousPort === undefined) delete process.env.OTLP_GRPC_PORT;
		else process.env.OTLP_GRPC_PORT = previousPort;
		if (previousHost === undefined) delete process.env.OTLP_GRPC_HOST;
		else process.env.OTLP_GRPC_HOST = previousHost;
	}
});

test("OTLP gRPC preserves a partial-success response", async () => {
	const port = await unusedLoopbackPort();
	const previousPort = process.env.OTLP_GRPC_PORT;
	process.env.OTLP_GRPC_PORT = String(port);
	const partial = Buffer.from([10, 2, 8, 1]);
	const stop = await startOtlpGrpcServer(
		() => new Response(partial, { status: 200 }),
	);
	const client = new grpc.Client(
		`127.0.0.1:${port}`,
		grpc.credentials.createInsecure(),
	);
	try {
		const metadata = new grpc.Metadata();
		metadata.set("authorization", "Bearer synthetic");
		metadata.set(
			"x-glasshouse-project-id",
			"33333333-3333-4333-8333-333333333333",
		);
		expect(
			await unary(client, traceExportPath, Buffer.alloc(0), metadata),
		).toEqual(partial);
	} finally {
		client.close();
		await stop?.();
		if (previousPort === undefined) delete process.env.OTLP_GRPC_PORT;
		else process.env.OTLP_GRPC_PORT = previousPort;
	}
});

test("OTLP gRPC maps temporary exporter failures to UNAVAILABLE", async () => {
	const port = await unusedLoopbackPort();
	const previousPort = process.env.OTLP_GRPC_PORT;
	process.env.OTLP_GRPC_PORT = String(port);
	const stop = await startOtlpGrpcServer(
		() => new Response(null, { status: 503 }),
	);
	const client = new grpc.Client(
		`127.0.0.1:${port}`,
		grpc.credentials.createInsecure(),
	);
	try {
		const metadata = new grpc.Metadata();
		metadata.set("authorization", "Bearer synthetic");
		metadata.set(
			"x-glasshouse-project-id",
			"33333333-3333-4333-8333-333333333333",
		);
		await expect(
			unary(client, traceExportPath, Buffer.alloc(0), metadata),
		).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
	} finally {
		client.close();
		await stop?.();
		if (previousPort === undefined) delete process.env.OTLP_GRPC_PORT;
		else process.env.OTLP_GRPC_PORT = previousPort;
	}
});

test("OTLP gRPC health validates requested service names", async () => {
	const port = await unusedLoopbackPort();
	const previousPort = process.env.OTLP_GRPC_PORT;
	process.env.OTLP_GRPC_PORT = String(port);
	const stop = await startOtlpGrpcServer(
		() => new Response(null, { status: 200 }),
	);
	const client = new grpc.Client(
		`127.0.0.1:${port}`,
		grpc.credentials.createInsecure(),
	);
	try {
		const service = Buffer.from(
			"opentelemetry.proto.collector.trace.v1.TraceService",
		);
		expect(
			await unary(
				client,
				healthPath,
				Buffer.concat([Buffer.from([10, service.length]), service]),
			),
		).toEqual(Buffer.from([8, 1]));
		await expect(
			unary(
				client,
				healthPath,
				Buffer.from([10, 7, ...Buffer.from("unknown")]),
			),
		).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
	} finally {
		client.close();
		await stop?.();
		if (previousPort === undefined) delete process.env.OTLP_GRPC_PORT;
		else process.env.OTLP_GRPC_PORT = previousPort;
	}
});
