"""Synthetic official SDK exports; credentials arrive only over stdin."""
import json
from pathlib import Path
import runpy
import sys

import grpc
import requests
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter as GrpcExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter as HttpExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider, SpanLimits
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExportResult
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.trace import Link, SpanContext, TraceFlags, TraceState, Status, StatusCode
from opentelemetry.proto.collector.trace.v1.trace_service_pb2_grpc import TraceServiceStub


def run(config):
    headers = {"authorization": config["ingest_auth"], "x-glasshouse-project-id": config["project"]}
    if config["transport"] == "http":
        exporter = HttpExporter(endpoint=config["api"] + "/v1/traces", headers=headers, timeout=10)
    else:
        exporter = GrpcExporter(endpoint=config["grpc"], headers=tuple(headers.items()), insecure=True, timeout=10, compression=grpc.Compression.Gzip)
    resource = Resource({"service.name": "fidelity-sdk", "created.ns": 1700000000000999999, "secret": "synthetic-secret"}, schema_url="https://example.test/resource/1")
    provider = TracerProvider(resource=resource, span_limits=SpanLimits(max_attributes=4, max_events=4, max_links=4, max_event_attributes=4, max_link_attributes=4))
    provider.add_span_processor(BatchSpanProcessor(exporter, schedule_delay_millis=60000))
    tracer = provider.get_tracer("fidelity.sdk", "1.0", schema_url="https://example.test/scope/1", attributes={"scope.attr": "scope-value", "secret": "synthetic-secret"})
    linked = SpanContext(0x112233445566778899AABBCCDDEEFF00, 0x1122334455667788, True, TraceFlags(1), TraceState([("vendor", "state")]))
    start = 1700000000000999999
    root = tracer.start_span("fidelity-root", start_time=start, links=[Link(linked, {"link.attr": "linked-value", "secret": "synthetic-secret"})], attributes={"span.attr": "span-value", "secret": "synthetic-secret"})
    with trace.use_span(root, end_on_exit=False):
        child = tracer.start_span("fidelity-child", start_time=start + 1)
        child.end(end_time=start + 2)
    root.record_exception(ValueError("synthetic-exception"), timestamp=start + 1)
    root.add_event("event", {"secret": "synthetic-secret", "safe": "event-value"}, timestamp=start + 2)
    root.set_status(Status(StatusCode.ERROR, "synthetic-status"))
    root.end(end_time=start + 2)
    assert provider.force_flush()
    # A retry through the actual exporter must preserve original wire identity.
    assert exporter.export([child, root]) == SpanExportResult.SUCCESS
    provider.shutdown()
    trace_id = f"{root.context.trace_id:032x}"
    response = requests.get(f"{config['api']}/v1/traces/{trace_id}", params={"project_id": config["project"]}, headers={"authorization": config["read_auth"]}, timeout=10)
    assert response.status_code == 200, response.status_code
    detail = response.json()
    assert len(detail["observations"]) == 2, "SDK event/link span was lost or retry duplicated rows"
    by_id = {o["observation_id"]: o for o in detail["observations"]}
    stored = by_id[f"{root.context.span_id:016x}"]
    assert stored["start_time_unix_nano"] == str(start)
    assert stored["end_time_unix_nano"] == str(start + 2)
    assert stored["duration_nano"] == "2"
    assert stored["duration_ms"] == 0.000002
    assert detail["trace"]["duration_nano"] == "2"
    assert by_id[f"{child.context.span_id:016x}"]["parent_observation_id"] == f"{root.context.span_id:016x}"
    otlp = stored["otlp"]
    assert otlp["events"][0]["time_unix_nano"] == str(start + 1)
    assert otlp["links"][0]["trace_id"] == "112233445566778899aabbccddeeff00"
    wire = encode_spans([root]).resource_spans[0].scope_spans[0].spans[0]
    assert otlp["links"][0]["flags"] == wire.links[0].flags
    assert otlp["flags"] == wire.flags
    assert otlp["status"]["code"] == 2
    assert otlp["resource"]["attributes"][1]["value"]["intValue"] == str(start)
    encoded = json.dumps(detail)
    assert "synthetic-secret" not in encoded
    if config["all_text"]:
        for secret in ["synthetic-exception", "synthetic-status", "scope-value", "event-value", "linked-value", "vendor=state", "https://example.test/"]:
            assert secret not in encoded, "all_text leaked telemetry string"
    else:
        assert otlp["scope"]["name"] == "fidelity.sdk"
        assert otlp["resource_schema_url"] == "https://example.test/resource/1"
        assert otlp["scope_schema_url"] == "https://example.test/scope/1"
        assert otlp["status"]["message"] == "synthetic-status"
        assert "synthetic-exception" in encoded
        assert "exception.stacktrace" in encoded
    for auth, project in [(config["other_auth"], config["project"]), (config["read_auth"], config["other_project"])]:
        denied = requests.get(f"{config['api']}/v1/traces/{trace_id}", params={"project_id": project}, headers={"authorization": auth}, timeout=10)
        assert denied.status_code == 404
        assert "synthetic-exception" not in denied.text
    denied = requests.get(f"{config['api']}/v1/traces/{trace_id}", params={"project_id": config["project"]}, headers={"authorization": config["ingest_auth"]}, timeout=10)
    assert denied.status_code == 401
    if not config["all_text"]:
        oversized = encode_spans([root])
        attribute = oversized.resource_spans[0].scope_spans[0].spans[0].attributes.add()
        attribute.key = "oversized"
        attribute.value.string_value = "x" * 1_048_577
        if config["transport"] == "http":
            response = requests.post(config["api"] + "/v1/traces", data=oversized.SerializeToString(), headers={**headers, "content-type": "application/x-protobuf"}, timeout=10)
            assert response.status_code == 413
        else:
            with grpc.insecure_channel(config["grpc"]) as channel:
                try:
                    TraceServiceStub(channel).Export(oversized, metadata=tuple(headers.items()), timeout=5)
                    raise AssertionError("oversized gRPC export unexpectedly accepted")
                except grpc.RpcError as error:
                    assert error.code() == grpc.StatusCode.RESOURCE_EXHAUSTED
        hosted = runpy.run_path(str(Path(__file__).with_name("otlp-sdk-integration.py")))
        endpoint = config["api"] if config["transport"] == "http" else config["grpc"]
        results, hosted_trace, hosted_ids = hosted["export"](config["transport"], endpoint, config["ingest_auth"], config["project"], "hosted-fidelity-" + trace_id)
        assert results == [SpanExportResult.SUCCESS]
        hosted["wait_for_names"](config["api"], config["read_auth"], config["project"], "hosted-fidelity-" + trace_id, hosted_trace, hosted_ids, fidelity=True)
    print(json.dumps({"trace_id": trace_id, "span_ids": list(by_id)}))


if __name__ == "__main__":
    run(json.load(sys.stdin))
