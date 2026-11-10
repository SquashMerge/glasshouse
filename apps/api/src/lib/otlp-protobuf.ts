import protobuf from "protobufjs";
import root from "@opentelemetry/otlp-proto-exporter-base/build/src/generated/root.js";
import { Reader } from "protobufjs/minimal.js";
import { mergeProtobufMessages } from "./protobuf-merge.js";

// Trace wire fields from opentelemetry-proto trace/v1 (including flags 16/6).
// The older exporter-base generated descriptor silently discards these flags.
const traceExport = protobuf
	.parse(`
syntax = "proto3";
message AnyValue {
  oneof value {
    string string_value = 1; bool bool_value = 2; int64 int_value = 3;
    double double_value = 4; ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6; bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message InstrumentationScope {
  string name = 1; string version = 2; repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}
message Status { reserved 1; string message = 2; int32 code = 3; }
message Event {
  fixed64 time_unix_nano = 1; string name = 2;
  repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4;
}
message Link {
  bytes trace_id = 1; bytes span_id = 2; string trace_state = 3;
  repeated KeyValue attributes = 4; uint32 dropped_attributes_count = 5;
  fixed32 flags = 6;
}
message Span {
  bytes trace_id = 1; bytes span_id = 2; string trace_state = 3;
  bytes parent_span_id = 4; string name = 5; int32 kind = 6;
  fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9; uint32 dropped_attributes_count = 10;
  repeated Event events = 11; uint32 dropped_events_count = 12;
  repeated Link links = 13; uint32 dropped_links_count = 14;
  Status status = 15; fixed32 flags = 16;
}
message ScopeSpans {
  InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3;
}
message ResourceSpans {
  Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3;
}
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
`)
	.root.lookupType("ExportTraceServiceRequest");

export function decodeOtlpTraceExport(bytes: Uint8Array): unknown {
	return traceExport.toObject(
		traceExport.decode(mergeProtobufMessages(bytes, traceExport)),
		{
			arrays: true,
			bytes: Array,
			longs: String,
			json: true,
		},
	);
}

const ExportMetricsServiceRequest = (
	root as unknown as {
		opentelemetry: {
			proto: {
				collector: {
					metrics: {
						v1: {
							ExportMetricsServiceRequest: {
								decode: (bytes: Uint8Array) => unknown;
								toObject: (message: unknown, options: object) => unknown;
							};
						};
					};
				};
			};
		};
	}
).opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest;

export function decodeOtlpMetricExport(bytes: Uint8Array): unknown {
	const options = { arrays: true, bytes: Array, enums: Number, longs: String };
	const output = ExportMetricsServiceRequest.toObject(
		ExportMetricsServiceRequest.decode(bytes),
		options,
	) as {
		resourceMetrics: {
			scopeMetrics: { metrics: { metadata?: unknown[] }[] }[];
		}[];
	};
	// The pinned generated schema predates Metric.metadata (OTLP field 12).
	// Recover only that field using its generated common.KeyValue codec.
	const keyValue = (
		root as unknown as {
			opentelemetry: {
				proto: {
					common: {
						v1: {
							KeyValue: {
								decode: (bytes: Uint8Array) => unknown;
								toObject: (value: unknown, options: object) => unknown;
							};
						};
					};
				};
			};
		}
	).opentelemetry.proto.common.v1.KeyValue;
	let r = 0;
	for (const resource of messageFields(bytes, 1)) {
		let s = 0;
		for (const scope of messageFields(resource, 2)) {
			let m = 0;
			for (const metric of messageFields(scope, 2)) {
				output.resourceMetrics[r]!.scopeMetrics[s]!.metrics[m]!.metadata =
					Array.from(messageFields(metric, 12), (value) =>
						keyValue.toObject(keyValue.decode(value), options),
					);
				m++;
			}
			s++;
		}
		r++;
	}
	return output;
}

function* messageFields(
	bytes: Uint8Array,
	field: number,
): Generator<Uint8Array> {
	const reader = Reader.create(bytes);
	while (reader.pos < reader.len) {
		const tag = reader.uint32();
		if (tag >>> 3 === field && (tag & 7) === 2) {
			const length = reader.uint32();
			const end = reader.pos + length;
			if (end > reader.len) throw new Error("Invalid protobuf message length");
			yield bytes.subarray(reader.pos, end);
			reader.pos = end;
		} else reader.skipType(tag & 7);
	}
}
