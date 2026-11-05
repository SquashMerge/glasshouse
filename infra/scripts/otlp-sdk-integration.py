#!/usr/bin/env python3
"""Exercise Glasshouse with the official OpenTelemetry Python exporters."""

import argparse
import base64
import gzip
import json
import os
import sys
import time
import uuid

import grpc
import requests
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter as GrpcExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter as HttpExporter
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExportResult


class ResultExporter:
    def __init__(self, exporter):
        self.exporter = exporter
        self.results = []

    def export(self, spans):
        result = self.exporter.export(spans)
        self.results.append(result)
        return result

    def shutdown(self):
        self.exporter.shutdown()

    def force_flush(self, timeout_millis=30000):
        return self.exporter.force_flush(timeout_millis)


def authorization(username: str, password: str) -> str:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return f"Basic {token}"


def telemetry_items(endpoint: str, auth: str, project_id: str, resource: str) -> list[dict]:
    response = requests.get(
        f"{endpoint}/v1/{resource}",
        params={"project_id": project_id, "limit": 200},
        headers={"authorization": auth},
        timeout=10,
    )
    response.raise_for_status()
    return response.json()["items"]


def create_tracer_provider() -> TracerProvider:
    return TracerProvider(
        resource=Resource.create(
            {"service.name": "glasshouse-otlp-sdk-test", "created.ns": 1700000000000999999},
            schema_url="https://example.test/resource/1",
        )
    )


def export(transport: str, endpoint: str, auth: str | None, project_id: str, marker: str):
    headers = {"x-glasshouse-project-id": project_id}
    if auth:
        headers["authorization"] = auth
    if transport == "http":
        # Exercise the SDK's standard base endpoint -> /v1/traces resolution.
        os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint
        exporter = HttpExporter(
            headers=headers, compression=Compression.Gzip
        )
    else:
        exporter = GrpcExporter(
            endpoint=endpoint.removeprefix("http://"),
            headers=tuple(headers.items()),
            insecure=True,
            compression=grpc.Compression.Gzip,
        )
    provider = create_tracer_provider()
    result_exporter = ResultExporter(exporter)
    provider.add_span_processor(
        BatchSpanProcessor(
            result_exporter,
            # Both spans are completed before flush, so each trace is one OTLP export.
            schedule_delay_millis=60_000,
            max_export_batch_size=2,
        )
    )
    tracer = provider.get_tracer("glasshouse.otlp.integration", "1.0", schema_url="https://example.test/scope/1")
    span_ids = []
    start = 1700000000000999999
    linked = trace.SpanContext(0x112233445566778899AABBCCDDEEFF00, 0x1122334455667788, True, trace.TraceFlags(1), trace.TraceState([("vendor", "state")]))
    with tracer.start_as_current_span(f"{marker}-root", start_time=start, end_on_exit=False, links=[trace.Link(linked)]) as root_span:
        root = trace.get_current_span().get_span_context()
        trace_id = f"{root.trace_id:032x}"
        span_ids.append(f"{root.span_id:016x}")
        with tracer.start_as_current_span(f"{marker}-child", start_time=start + 1, end_on_exit=False) as child_span:
            span_ids.append(f"{trace.get_current_span().get_span_context().span_id:016x}")
            child_span.end(end_time=start + 2)
        root_span.record_exception(ValueError("synthetic-sdk-exception"), timestamp=start + 1)
        root_span.set_status(trace.Status(trace.StatusCode.ERROR, "synthetic-sdk-status"))
        root_span.end(end_time=start + 2)
    if not provider.force_flush():
        raise AssertionError("SDK exporter did not flush")
    provider.shutdown()
    return result_exporter.results, trace_id, span_ids


def wait_for_names(
    endpoint: str,
    auth: str,
    project_id: str,
    marker: str,
    trace_id: str,
    span_ids: list[str],
    fidelity: bool = False,
) -> list[str]:
    expected = {f"{marker}-root", f"{marker}-child"}
    for _ in range(20):
        observations = telemetry_items(endpoint, auth, project_id, "observations")
        by_name = {item["name"]: item for item in observations}
        if expected.issubset(by_name):
            root = by_name[f"{marker}-root"]
            child = by_name[f"{marker}-child"]
            if (
                root.get("trace_id") == trace_id
                and child.get("trace_id") == trace_id
                and root.get("observation_id") == span_ids[0]
                and child.get("observation_id") == span_ids[1]
                and child.get("parent_observation_id") == span_ids[0]
            ):
                if fidelity:
                    response = requests.get(
                        f"{endpoint}/v1/traces/{trace_id}", params={"project_id": project_id},
                        headers={"authorization": auth}, timeout=10,
                    )
                    response.raise_for_status()
                    detail = response.json()
                    retained = next(o for o in detail["observations"] if o["observation_id"] == span_ids[0])
                    assert retained["start_time_unix_nano"] == "1700000000000999999"
                    assert retained["end_time_unix_nano"] == "1700000000001000001"
                    assert retained["duration_nano"] == "2"
                    assert retained["duration_ms"] == 0.000002
                    assert retained["otlp"]["events"][0]["time_unix_nano"] == "1700000000001000000"
                    assert retained["otlp"]["events"][0]["name"] == "exception"
                    assert retained["otlp"]["links"][0]["trace_id"] == "112233445566778899aabbccddeeff00"
                    assert "flags" in retained["otlp"]["links"][0]
                    assert retained["otlp"]["status"]["message"] == "synthetic-sdk-status"
                    assert retained["otlp"]["resource_schema_url"] == "https://example.test/resource/1"
                    assert retained["otlp"]["scope_schema_url"] == "https://example.test/scope/1"
                return [root["observation_id"], child["observation_id"]]
        time.sleep(0.25)
    raise AssertionError(f"{marker}: root and child were not persisted")


def export_http_json(endpoint: str, auth: str, project_id: str, marker: str) -> tuple[str, list[str]]:
    trace_id = uuid.uuid4().hex
    root_id = uuid.uuid4().hex[:16]
    child_id = uuid.uuid4().hex[:16]
    now = str(time.time_ns())
    payload = {
        "resourceSpans": [{
            "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "glasshouse-otlp-json-test"}}]},
            "scopeSpans": [{
                "scope": {"name": "glasshouse.otlp.integration.json"},
                "spans": [
                    {"traceId": trace_id, "spanId": root_id, "name": f"{marker}-root", "startTimeUnixNano": now, "endTimeUnixNano": now},
                    {"traceId": trace_id, "spanId": child_id, "parentSpanId": root_id, "name": f"{marker}-child", "startTimeUnixNano": now, "endTimeUnixNano": now},
                ],
            }],
        }],
    }
    response = requests.post(
        f"{endpoint}/v1/traces",
        data=gzip.compress(json.dumps(payload).encode()),
        headers={
            "authorization": auth,
            "x-glasshouse-project-id": project_id,
            "content-type": "application/json",
            "content-encoding": "gzip",
        },
        timeout=10,
    )
    response.raise_for_status()
    return trace_id, [root_id, child_id]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--transport", choices=("http", "grpc"), required=True)
    parser.add_argument("--api-endpoint", required=True)
    parser.add_argument("--grpc-endpoint", default="http://127.0.0.1:4317")
    parser.add_argument("--username", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--ingest-token", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--wrong-project-id", required=True)
    parser.add_argument("--result-file", required=True)
    args = parser.parse_args()

    auth = authorization(args.username, args.password)
    ingest_auth = f"Bearer {args.ingest_token}"
    marker = f"sdk-{args.transport}-{uuid.uuid4().hex}"
    endpoint = args.api_endpoint if args.transport == "http" else args.grpc_endpoint
    results, trace_id, span_ids = export(args.transport, endpoint, ingest_auth, args.project_id, marker)
    if results != [SpanExportResult.SUCCESS]:
        raise AssertionError(f"authenticated exporter result was {results}")
    observation_ids = wait_for_names(
        args.api_endpoint, auth, args.project_id, marker, trace_id, span_ids, fidelity=True
    )
    trace_ids = [trace_id]
    if args.transport == "http":
        json_marker = f"{marker}-json"
        json_trace_id, json_span_ids = export_http_json(
            args.api_endpoint, ingest_auth, args.project_id, json_marker
        )
        trace_ids.append(json_trace_id)
        observation_ids.extend(
            wait_for_names(
                args.api_endpoint,
                auth,
                args.project_id,
                json_marker,
                json_trace_id,
                json_span_ids,
            )
        )

    unauthenticated_marker = f"{marker}-unauthenticated"
    unauthenticated_results, unauthenticated_trace, unauthenticated_ids = export(
        args.transport, endpoint, None, args.project_id, unauthenticated_marker
    )
    if any(result == SpanExportResult.SUCCESS for result in unauthenticated_results):
        raise AssertionError("unauthenticated exporter unexpectedly succeeded")
    time.sleep(0.5)
    if any(
        name.startswith(unauthenticated_marker)
        for name in (
            item["name"]
            for item in telemetry_items(
                args.api_endpoint, auth, args.project_id, "observations"
            )
        )
    ):
        raise AssertionError("unauthenticated OTLP export wrote telemetry")

    # This credential is bound to the first Project and cannot target an existing second Project.
    rejected_marker = f"{marker}-wrong"
    wrong_results, wrong_trace, wrong_ids = export(
        args.transport, endpoint, ingest_auth, args.wrong_project_id, rejected_marker
    )
    if any(result == SpanExportResult.SUCCESS for result in wrong_results):
        raise AssertionError("wrong-project exporter unexpectedly succeeded")
    time.sleep(0.5)
    with open(args.result_file, "w", encoding="utf-8") as result_file:
        json.dump(
            {
                "trace_ids": trace_ids,
                "observation_ids": observation_ids,
                "denied_trace_ids": [unauthenticated_trace, wrong_trace],
                "denied_observation_ids": unauthenticated_ids + wrong_ids,
            },
            result_file,
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"OTLP SDK interoperability failed: {error}", file=sys.stderr)
        raise
