import root from "@opentelemetry/otlp-proto-exporter-base/build/src/generated/root.js";

const ExportTraceServiceRequest = (
	root as unknown as {
		opentelemetry: {
			proto: {
				collector: {
					trace: {
						v1: {
							ExportTraceServiceRequest: {
								decode: (bytes: Uint8Array) => unknown;
								toObject: (message: unknown, options: object) => unknown;
							};
						};
					};
				};
			};
		};
	}
).opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

export function decodeOtlpTraceExport(bytes: Uint8Array): unknown {
	return ExportTraceServiceRequest.toObject(
		ExportTraceServiceRequest.decode(bytes),
		{
			arrays: true,
			bytes: Array,
			enums: Number,
			longs: String,
		},
	);
}
