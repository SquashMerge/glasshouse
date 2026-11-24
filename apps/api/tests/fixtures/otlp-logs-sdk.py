"""Real, hash-locked OTel SDK sender for otlp-logs.test.ts; configuration is stdin."""

import json
import logging
import os
import sys

import grpc
from opentelemetry._logs import LogRecord, SeverityNumber
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import (
    OTLPLogExporter as GrpcExporter,
)
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.exporter.otlp.proto.http._log_exporter import (
    OTLPLogExporter as HttpExporter,
)
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import (
    LogRecordExportResult,
    SimpleLogRecordProcessor,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.trace import (
    NonRecordingSpan,
    SpanContext,
    TraceFlags,
    set_span_in_context,
)


class RecordingExporter:
    def __init__(self, exporter):
        self.exporter = exporter
        self.results = []

    def export(self, records):
        result = self.exporter.export(records)
        self.results.append(result)
        return result

    def shutdown(self):
        self.exporter.shutdown()


def main():
    # SDK diagnostics may include response text. Only the bounded result crosses stdout.
    logging.disable(logging.CRITICAL)
    config = json.load(sys.stdin)
    headers = {"x-glasshouse-project-id": config["project_id"]}
    if config.get("authorization"):
        headers["authorization"] = config["authorization"]
    if config["transport"] == "http":
        # Deliberately exercise the SDK's base endpoint -> /v1/logs resolution.
        os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = config["endpoint"]
        exporter = HttpExporter(
            headers=headers, timeout=4, compression=Compression.Gzip
        )
    else:
        exporter = GrpcExporter(
            endpoint=config["endpoint"],
            headers=tuple(headers.items()),
            insecure=True,
            timeout=4,
            compression=grpc.Compression.Gzip,
        )
    recording = RecordingExporter(exporter)
    provider = LoggerProvider(
        resource=Resource.create({"service.name": "glasshouse-real-logs-sdk"}),
        shutdown_on_exit=False,
    )
    provider.add_log_record_processor(SimpleLogRecordProcessor(recording))
    span_context = SpanContext(
        trace_id=int(config["trace_id"], 16),
        span_id=int(config["span_id"], 16),
        is_remote=False,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
    )
    try:
        provider.get_logger("glasshouse.logs.sdk", "1.0").emit(
            LogRecord(
                timestamp=int(config["time_unix_nano"]),
                observed_timestamp=int(config["observed_time_unix_nano"]),
                context=set_span_in_context(NonRecordingSpan(span_context)),
                severity_number=SeverityNumber.WARN,
                severity_text="WARN",
                body={"message": config["marker"], "steps": ["received", True, 7]},
                attributes={"test.marker": config["marker"]},
            )
        )
        flushed = provider.force_flush(timeout_millis=5000)
    finally:
        provider.shutdown()
    print(json.dumps({
        "attempts": len(recording.results),
        "exported": flushed and recording.results == [LogRecordExportResult.SUCCESS],
    }))


if __name__ == "__main__":
    main()
