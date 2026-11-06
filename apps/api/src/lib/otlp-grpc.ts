import * as grpc from "@grpc/grpc-js";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { logger } from "./logger.js";

const TRACE_SERVICE_PATH =
	"/opentelemetry.proto.collector.trace.v1.TraceService/Export";
const HEALTH_SERVICE_PATH = "/grpc.health.v1.Health/Check";
const TRACE_SERVICE_NAME =
	"opentelemetry.proto.collector.trace.v1.TraceService";
const LOGS_SERVICE_NAME = "opentelemetry.proto.collector.logs.v1.LogsService";

type Fetch = (request: Request) => Response | Promise<Response>;

export async function startOtlpGrpcServer(fetch: Fetch) {
	const port = Number(process.env.OTLP_GRPC_PORT);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
	const configuredHost = process.env.OTLP_GRPC_HOST ?? "127.0.0.1";
	const host = await resolvePrivateBindHost(configuredHost);
	if (!host)
		throw new Error("OTLP_GRPC_HOST must be a loopback or private address");
	const maxReceiveBytes = parsePositiveInt(
		process.env.OTLP_GRPC_MAX_RECEIVE_BYTES,
		1_048_576,
	);
	const server = new grpc.Server({
		"grpc.max_receive_message_length": maxReceiveBytes,
		"grpc.max_send_message_length": 1024,
	});
	for (const [path, endpoint] of [
		[TRACE_SERVICE_PATH, "/v1/traces"],
		[`/${LOGS_SERVICE_NAME}/Export`, "/v1/logs"],
	] as const)
		server.addService(
			{
				Export: {
					path,
					requestStream: false,
					responseStream: false,
					requestSerialize: (value: Buffer) => value,
					requestDeserialize: (value: Buffer) => value,
					responseSerialize: (value: Buffer) => value,
					responseDeserialize: (value: Buffer) => value,
				},
			},
			{
				Export: async (
					call: grpc.ServerUnaryCall<Buffer, Buffer>,
					callback: grpc.sendUnaryData<Buffer>,
				) => {
					const authorization = oneMetadataValue(
						call.metadata,
						"authorization",
					);
					const projectId = oneMetadataValue(
						call.metadata,
						"x-glasshouse-project-id",
					);
					if (!authorization || !projectId) {
						callback({
							code: grpc.status.UNAUTHENTICATED,
							message: "Authentication required",
						});
						return;
					}
					try {
						const response = await fetch(
							new Request(`http://otlp-grpc.internal${endpoint}`, {
								method: "POST",
								headers: {
									authorization,
									"x-glasshouse-project-id": projectId,
									"content-type": "application/x-protobuf",
								},
								body: call.request,
							}),
						);
						if (response.ok)
							return callback(null, Buffer.from(await response.arrayBuffer()));
						callback({
							code: grpcStatus(response.status),
							message: "Telemetry export rejected",
						});
					} catch (cause) {
						logger.error("otlp.grpc_export_failed", cause);
						callback({
							code: grpc.status.INTERNAL,
							message: "Telemetry export failed",
						});
					}
				},
			},
		);
	server.addService(
		{
			Check: {
				path: HEALTH_SERVICE_PATH,
				requestStream: false,
				responseStream: false,
				requestSerialize: (value: Buffer) => value,
				requestDeserialize: (value: Buffer) => value,
				responseSerialize: (value: Buffer) => value,
				responseDeserialize: (value: Buffer) => value,
			},
		},
		{
			Check: (
				call: grpc.ServerUnaryCall<Buffer, Buffer>,
				callback: grpc.sendUnaryData<Buffer>,
			) => {
				try {
					const service = decodeHealthService(call.request);
					if (
						service === "" ||
						service === TRACE_SERVICE_NAME ||
						service === LOGS_SERVICE_NAME
					)
						return callback(null, Buffer.from([8, 1]));
					return callback({
						code: grpc.status.NOT_FOUND,
						message: "Service not found",
					});
				} catch {
					return callback({
						code: grpc.status.INVALID_ARGUMENT,
						message: "Invalid health check request",
					});
				}
			},
		},
	);
	try {
		await new Promise<void>((resolve, reject) => {
			server.bindAsync(
				`${isIP(host) === 6 ? `[${host}]` : host}:${port}`,
				grpc.ServerCredentials.createInsecure(),
				(error) => (error ? reject(error) : resolve()),
			);
		});
	} catch (error) {
		logger.error("otlp.grpc_bind_failed", error, { host, port });
		server.forceShutdown();
		throw error;
	}
	logger.info("otlp.grpc_started", {
		host,
		port,
		max_receive_bytes: maxReceiveBytes,
	});
	return () => gracefulShutdown(server);
}

function decodeHealthService(bytes: Buffer): string {
	if (!bytes.length) return "";
	if (bytes[0] !== 10) throw new Error("Invalid health check request");
	let offset = 1;
	let length = 0;
	let shift = 0;
	while (offset < bytes.length) {
		const byte = bytes[offset++]!;
		length |= (byte & 0x7f) << shift;
		if (!(byte & 0x80)) break;
		shift += 7;
		if (shift > 28) throw new Error("Invalid health check request");
	}
	if (offset + length !== bytes.length)
		throw new Error("Invalid health check request");
	return new TextDecoder("utf-8", { fatal: true }).decode(
		bytes.subarray(offset, offset + length),
	);
}

function oneMetadataValue(metadata: grpc.Metadata, key: string): string | null {
	const values = metadata.get(key);
	return values.length === 1 &&
		typeof values[0] === "string" &&
		!values[0].includes(",")
		? values[0]
		: null;
}

function grpcStatus(httpStatus: number): grpc.status {
	if (httpStatus === 401) return grpc.status.UNAUTHENTICATED;
	if (httpStatus === 404 || httpStatus === 403)
		return grpc.status.PERMISSION_DENIED;
	if (httpStatus === 429 || httpStatus === 503) return grpc.status.UNAVAILABLE;
	if (httpStatus === 413) return grpc.status.RESOURCE_EXHAUSTED;
	if (httpStatus >= 400 && httpStatus < 500)
		return grpc.status.INVALID_ARGUMENT;
	return grpc.status.INTERNAL;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isPrivateBindHost(host: string): boolean {
	if (host === "localhost") return true;
	const family = isIP(host);
	if (family === 4) {
		const [first, second] = host.split(".").map(Number);
		return (
			first === 127 ||
			first === 10 ||
			(first === 172 && second !== undefined && second >= 16 && second <= 31) ||
			(first === 192 && second === 168)
		);
	}
	return family === 6 && (host === "::1" || /^f[cd][0-9a-f:]+$/i.test(host));
}

async function resolvePrivateBindHost(host: string): Promise<string | null> {
	if (isPrivateBindHost(host)) return host;
	try {
		const address = await lookup(host);
		return isPrivateBindHost(address.address) ? address.address : null;
	} catch {
		return null;
	}
}

function gracefulShutdown(server: grpc.Server): Promise<void> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			server.forceShutdown();
			resolve();
		}, 10_000);
		timeout.unref();
		server.tryShutdown(() => {
			clearTimeout(timeout);
			resolve();
		});
	});
}
