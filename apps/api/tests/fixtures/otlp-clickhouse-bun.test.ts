import { expect, test } from "bun:test";
import { createServer } from "node:http";
import {
	type AddressInfo,
	createServer as createTcpServer,
	type Socket,
} from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@clickhouse/client";
import * as grpc from "@grpc/grpc-js";
import protobufRoot from "@opentelemetry/otlp-proto-exporter-base/build/src/generated/root.js";
import { normalizeSpan } from "../../src/db/gen-ai-attrs.js";
import {
	insertObservations,
	insertTraces,
} from "../../src/db/traces-writer.js";
import { startOtlpGrpcServer } from "../../src/lib/otlp-grpc.js";
import { createOtlpIngestHandler } from "../../src/routes/otlp.js";

const tenant = {
	actorId: "11111111-1111-4111-8111-111111111111",
	organizationId: "22222222-2222-4222-8222-222222222222",
	projectId: "33333333-3333-4333-8333-333333333333",
};
const span = {
	traceId: "00112233445566778899aabbccddeeff",
	spanId: "0011223344556677",
	name: "timeout-regression",
	startTimeUnixNano: "1700000000000000000",
};
const payload = { resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] };
const requestTimeout = 50;

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} did not settle within 1500ms`)),
					1500,
				);
			}),
		]);
	} finally {
		clearTimeout(timer!);
	}
}

async function stalledClickHouse(
	table: string,
	stage: "headers" | "body",
	socketTimeout = requestTimeout,
) {
	const sockets = new Set<Socket>();
	const requests: Array<{ table: string; token: string; body: string }> = [];
	const committed = new Map<string, string>();
	let stall = true;
	let disconnected = false;
	let closed!: () => void;
	const aborted = new Promise<void>((resolve) => {
		closed = resolve;
	});
	// A raw socket observes FIN directly; an HTTP server can pause its parser
	// while awaiting a response and hide peer closure from socket event handlers.
	const server = createTcpServer((socket) => {
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			const headerEnd = buffered.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const headers = buffered.subarray(0, headerEnd).toString();
			const length = Number(/content-length: (\d+)/i.exec(headers)![1]);
			if (buffered.length < headerEnd + 4 + length) return;
			const url = new URL(headers.split(" ")[1]!, "http://127.0.0.1");
			const target = url.searchParams.get("query")!.split(" ")[2]!;
			const token = url.searchParams.get("insert_deduplication_token")!;
			const body = buffered
				.subarray(headerEnd + 4, headerEnd + 4 + length)
				.toString();
			buffered = buffered.subarray(headerEnd + 4 + length);
			requests.push({ table: target, token, body });
			// Model an accepted write whose acknowledgement never arrives.
			committed.set(token, body);
			if (stall && target === table) {
				socket.once("close", () => {
					disconnected = true;
					closed();
				});
				if (stage === "body")
					socket.write(
						"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n \r\n",
					);
			} else socket.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const client = createClient({
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		request_timeout: socketTimeout,
		max_open_connections: 1,
		log: { level: "OFF" },
	});
	return {
		client,
		requests,
		committed,
		aborted,
		disconnected: () => disconnected,
		activeSockets: () => sockets.size,
		recover: () => {
			stall = false;
		},
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await client.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function rows() {
	const { trace, observation } = normalizeSpan({
		trace_id: span.traceId,
		span_id: span.spanId,
		name: span.name,
		start_time_unix_nano: 1_700_000_000_000_000_000,
	});
	trace.organization_id = observation.organization_id = tenant.organizationId;
	trace.project_id = observation.project_id = tenant.projectId;
	return { trace, observation };
}

for (const table of ["traces", "observations"] as const) {
	for (const stage of ["headers", "body"] as const) {
		test(`the ${table} ${stage} deadline itself aborts I/O before the native socket timeout`, async () => {
			const fixture = await stalledClickHouse(table, stage, 5_000);
			const { trace, observation } = rows();
			try {
				const work =
					table === "traces"
						? insertTraces(
								fixture.client,
								[trace],
								"deadline-probe",
								requestTimeout,
							)
						: insertObservations(
								fixture.client,
								[observation],
								"deadline-probe",
								requestTimeout,
							);
				const failure = await bounded(
					work.catch((error: unknown) => error),
					"insert deadline",
				);
				expect(failure).toMatchObject({
					code: "ETIMEDOUT",
					message: "ClickHouse insert timed out",
				});
				await bounded(fixture.aborted, "deadline socket cancellation");
				expect(fixture.activeSockets()).toBe(0);
				expect(fixture.requests).toHaveLength(1);
			} finally {
				await fixture.close();
			}
		});
	}
}

test("insert deadlines are cleared after success and non-timeout failure", async () => {
	const signals: AbortSignal[] = [];
	const failure = new Error("synthetic storage failure");
	const { trace, observation } = rows();
	for (const reject of [false, true]) {
		const client = {
			insert: async ({ abort_signal }: { abort_signal: AbortSignal }) => {
				signals.push(abort_signal);
				if (reject) throw failure;
			},
		};
		for (const run of [
			() =>
				insertTraces(client as never, [trace], "timer-cleanup", requestTimeout),
			() =>
				insertObservations(
					client as never,
					[observation],
					"timer-cleanup",
					requestTimeout,
				),
		]) {
			const work = run();
			if (reject) await expect(work).rejects.toBe(failure);
			else await work;
		}
	}
	await delay(100);
	expect(signals).toHaveLength(4);
	expect(signals.every((signal) => !signal.aborted)).toBe(true);
});

function protobufPayload() {
	const trace = (
		protobufRoot as unknown as {
			opentelemetry: {
				proto: {
					collector: {
						trace: {
							v1: {
								ExportTraceServiceRequest: {
									fromObject: (value: object) => object;
									encode: (value: object) => { finish: () => Uint8Array };
								};
							};
						};
					};
				};
			};
		}
	).opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
	return Buffer.from(
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
}

for (const table of ["traces", "observations"] as const) {
	for (const transport of ["http", "grpc"] as const) {
		for (const stage of ["headers", "body"] as const) {
			test(`Bun ${transport} aborts stalled ${table} ${stage}, sanitizes failure, and safely retries`, async () => {
				const fixture = await stalledClickHouse(table, stage);
				const events: string[] = [];
				const handler = createOtlpIngestHandler({
					withActiveAuthorizedProjectLock: async (_scope, callback) =>
						callback({} as never),
					approvedRedaction: async () => null,
					defaultClient: () => fixture.client,
					insertTraces: (client, rows, token) =>
						insertTraces(client, rows, token, requestTimeout),
					insertObservations: (client, rows, token) =>
						insertObservations(client, rows, token, requestTimeout),
					publishSync: (event) => events.push(event),
				});
				const previousPort = process.env.OTLP_GRPC_PORT;
				const previousHost = process.env.OTLP_GRPC_HOST;
				let stop: Awaited<ReturnType<typeof startOtlpGrpcServer>> = null;
				let grpcClient: grpc.Client | undefined;
				const api = createServer(async (request, response) => {
					const chunks: Buffer[] = [];
					for await (const chunk of request) chunks.push(Buffer.from(chunk));
					const result = await handler(
						new Request("http://127.0.0.1/v1/traces", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: Buffer.concat(chunks),
						}),
						tenant,
					);
					response.writeHead(result.status);
					response.end(await result.text());
				});
				try {
					await new Promise<void>((resolve) =>
						api.listen(0, "127.0.0.1", resolve),
					);
					const port = (api.address() as AddressInfo).port;
					if (transport === "grpc") {
						await new Promise<void>((resolve) => api.close(() => resolve()));
						process.env.OTLP_GRPC_HOST = "127.0.0.1";
						process.env.OTLP_GRPC_PORT = String(port);
						stop = await startOtlpGrpcServer((request) =>
							handler(request, tenant),
						);
						grpcClient = new grpc.Client(
							`127.0.0.1:${port}`,
							grpc.credentials.createInsecure(),
						);
					}
					const send = async () => {
						if (transport === "http") {
							const response = await fetch(
								`http://127.0.0.1:${port}/v1/traces`,
								{
									method: "POST",
									body: JSON.stringify(payload),
								},
							);
							return { status: response.status, body: await response.json() };
						}
						const metadata = new grpc.Metadata();
						metadata.set("authorization", "Bearer synthetic");
						metadata.set("x-glasshouse-project-id", tenant.projectId);
						return new Promise((resolve) => {
							grpcClient!.makeUnaryRequest(
								"/opentelemetry.proto.collector.trace.v1.TraceService/Export",
								(value: Buffer) => value,
								(value: Buffer) => value,
								protobufPayload(),
								metadata,
								{ deadline: Date.now() + 2_000 },
								(error, response) =>
									resolve(
										error
											? { code: error.code, details: error.details }
											: response,
									),
							);
						});
					};
					const failure = await bounded(
						send(),
						`${transport} ${table} ${stage}`,
					);
					expect(failure).toEqual(
						transport === "http"
							? {
									status: 503,
									body: { message: "Trace export temporarily unavailable" },
								}
							: {
									code: grpc.status.UNAVAILABLE,
									details: "Trace export rejected",
								},
					);
					expect(events).toEqual([]);
					await bounded(fixture.aborted, "ClickHouse socket cancellation");
					expect(fixture.disconnected()).toBe(true);
					expect(fixture.activeSockets()).toBe(0);
					const beforeRetry = table === "traces" ? 1 : 2;
					expect(fixture.requests).toHaveLength(beforeRetry);
					await delay(100);
					expect(fixture.requests).toHaveLength(beforeRetry);
					fixture.recover();
					const success = await bounded(send(), "retry");
					expect(success).toEqual(
						transport === "http" ? { status: 200, body: {} } : Buffer.alloc(0),
					);
					expect(events).toEqual(["trace.created", "observation.created"]);
					expect(fixture.requests).toHaveLength(beforeRetry + 2);
					for (const target of ["traces", "observations"]) {
						const attempts = fixture.requests.filter(
							(request) => request.table === target,
						);
						expect(new Set(attempts.map((request) => request.token)).size).toBe(
							1,
						);
						expect(new Set(attempts.map((request) => request.body)).size).toBe(
							1,
						);
						expect(attempts[0]!.token).toStartWith(
							`glasshouse:otlp:${target}:`,
						);
					}
					expect(fixture.committed.size).toBe(2);
				} finally {
					await fixture.close();
					grpcClient?.close();
					await stop?.();
					api.closeAllConnections();
					await new Promise<void>((resolve) => api.close(() => resolve()));
					if (previousPort === undefined) delete process.env.OTLP_GRPC_PORT;
					else process.env.OTLP_GRPC_PORT = previousPort;
					if (previousHost === undefined) delete process.env.OTLP_GRPC_HOST;
					else process.env.OTLP_GRPC_HOST = previousHost;
				}
			}, 5_000);
		}
	}
}
