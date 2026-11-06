import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@clickhouse/client";
import * as grpc from "@grpc/grpc-js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import protobufRoot from "@opentelemetry/otlp-proto-exporter-base/build/src/generated/root.js";
import { startOtlpGrpcServer } from "../../src/lib/otlp-grpc.js";
import { createOtlpIngestHandler } from "../../src/routes/otlp.js";

const tenant = {
	actorId: "11111111-1111-4111-8111-111111111111",
	organizationId: "22222222-2222-4222-8222-222222222222",
	projectId: "33333333-3333-4333-8333-333333333333",
};
const payload = {
	resourceSpans: [
		{
			scopeSpans: [
				{
					spans: [
						{
							traceId: "00112233445566778899aabbccddeeff",
							spanId: "0011223344556677",
							name: "timeout-regression",
							startTimeUnixNano: "1700000000000000000",
						},
					],
				},
			],
		},
	],
};

async function timeoutFixture() {
	let requests = 0;
	const server = createServer((request) => {
		requests += 1;
		request.resume();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const client = createClient({
		url: `http://127.0.0.1:${port}`,
		request_timeout: 50,
	});
	return {
		client,
		requests: () => requests,
		close: async () => {
			await client.close();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

test("the pinned ClickHouse client produces an uncoded timeout against a real loopback stub", async () => {
	const fixture = await timeoutFixture();
	try {
		const failure = await fixture.client
			.insert({
				table: "traces",
				values: [{ test: true }],
				format: "JSONEachRow",
			})
			.catch((error: unknown) => error);
		assert.equal(fixture.requests(), 1);
		assert(failure instanceof Error);
		assert.equal(failure.message, "Timeout error.");
		assert.equal("code" in failure, false);
	} finally {
		await fixture.close();
	}
});

for (const table of ["traces", "observations"] as const) {
	for (const transport of ["http", "grpc"] as const) {
		test(`OTLP ${transport} returns a retryable response for a real ${table} insert timeout`, async () => {
			const fixture = await timeoutFixture();
			let published = 0;
			const handler = createOtlpIngestHandler({
				withActiveAuthorizedProjectLock: async (_tenant, callback) =>
					callback({} as never),
				approvedRedaction: async () => null,
				defaultClient: () => fixture.client,
				...(table === "observations"
					? { insertTraces: async () => undefined }
					: {}),
				publishSync: () => {
					published += 1;
				},
			});
			const previousPort = process.env.OTLP_GRPC_PORT;
			const previousHost = process.env.OTLP_GRPC_HOST;
			let stop: Awaited<ReturnType<typeof startOtlpGrpcServer>> = null;
			let client: grpc.Client | undefined;
			try {
				if (transport === "http") {
					const response = await handler(
						new Request("http://localhost/v1/traces", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(payload),
						}),
						tenant,
					);
					assert.equal(response.status, 503);
					assert.deepEqual(await response.json(), {
						message: "Trace export temporarily unavailable",
					});
				} else {
					const probe = createServer();
					await new Promise<void>((resolve) =>
						probe.listen(0, "127.0.0.1", resolve),
					);
					const port = (probe.address() as AddressInfo).port;
					await new Promise<void>((resolve) => probe.close(() => resolve()));
					process.env.OTLP_GRPC_PORT = String(port);
					process.env.OTLP_GRPC_HOST = "127.0.0.1";
					stop = await startOtlpGrpcServer((request) =>
						handler(request, tenant),
					);
					client = new grpc.Client(
						`127.0.0.1:${port}`,
						grpc.credentials.createInsecure(),
					);
					const metadata = new grpc.Metadata();
					metadata.set("authorization", "Bearer synthetic");
					metadata.set("x-glasshouse-project-id", tenant.projectId);
					const trace = (
						protobufRoot as unknown as {
							opentelemetry: {
								proto: {
									collector: {
										trace: {
											v1: {
												ExportTraceServiceRequest: {
													fromObject: (value: object) => object;
													encode: (value: object) => {
														finish: () => Uint8Array;
													};
												};
											};
										};
									};
								};
							};
						}
					).opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
					const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
					const bytes = Buffer.from(
						trace
							.encode(
								trace.fromObject({
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
								}),
							)
							.finish(),
					);
					const result = new Promise<Buffer>((resolve, reject) => {
						client!.makeUnaryRequest(
							"/opentelemetry.proto.collector.trace.v1.TraceService/Export",
							(value: Buffer) => value,
							(value: Buffer) => value,
							bytes,
							metadata,
							{ deadline: Date.now() + 2_000 },
							(error, response) => (error ? reject(error) : resolve(response)),
						);
					});
					await assert.rejects(result, {
						code: grpc.status.UNAVAILABLE,
						details: "Trace export rejected",
					});
				}
				assert.equal(fixture.requests(), 1);
				assert.equal(published, 0);
			} finally {
				client?.close();
				await stop?.();
				await fixture.close();
				if (previousPort === undefined) delete process.env.OTLP_GRPC_PORT;
				else process.env.OTLP_GRPC_PORT = previousPort;
				if (previousHost === undefined) delete process.env.OTLP_GRPC_HOST;
				else process.env.OTLP_GRPC_HOST = previousHost;
			}
		});
	}
}

test("timeout-like application failures remain internal and sanitized", async () => {
	for (const failure of [
		new Error("Timeout error."),
		new Error("Unexpected timeout in application code"),
		Object.assign(new Error("Timeout error."), { code: "62" }),
	]) {
		const handler = createOtlpIngestHandler({
			withActiveAuthorizedProjectLock: async () => {
				throw failure;
			},
		});
		const response = await handler(
			new Request("http://localhost/v1/traces", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			}),
			tenant,
		);
		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), { message: "Trace export failed" });
	}
});

test("non-timeout ClickHouse insert errors are not promoted to retryable failures", async () => {
	for (const failure of [
		new Error("Unexpected timeout in application code"),
		new TypeError("Timeout error."),
		Object.assign(new Error("Timeout error."), { code: "62" }),
		"Timeout error.",
	]) {
		const handler = createOtlpIngestHandler({
			withActiveAuthorizedProjectLock: async (_tenant, callback) =>
				callback({} as never),
			approvedRedaction: async () => null,
			defaultClient: () =>
				({
					insert: async () => {
						throw failure;
					},
				}) as never,
		});
		const response = await handler(
			new Request("http://localhost/v1/traces", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			}),
			tenant,
		);
		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), { message: "Trace export failed" });
	}
});
