"""Live official-exporter probe; use infra/otlp-sdk-requirements.txt's locked SDK.

The Bun metrics integration suite supplies only synthetic credentials and its
own loopback listeners. This fixture never selects or starts a datastore.
"""

import json
import logging
import os
import sys
from urllib.parse import urlsplit

import grpc
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
    OTLPMetricExporter as GrpcExporter,
)
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
    OTLPMetricExporter as HttpExporter,
)
from opentelemetry.metrics import Observation
from opentelemetry.sdk.metrics import Counter, MeterProvider
from opentelemetry.sdk.metrics.export import (
    AggregationTemporality,
    InMemoryMetricReader,
    MetricExportResult,
)
from opentelemetry.sdk.resources import Resource


def main():
    logging.disable(logging.CRITICAL)
    if os.environ.get("METRICS_TEST_PROTO_METADATA") == "1":
        from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import (
            ExportMetricsServiceRequest,
        )

        request = ExportMetricsServiceRequest()
        metric = request.resource_metrics.add().scope_metrics.add().metrics.add()
        metric.name = os.environ["METRICS_TEST_PREFIX"]
        metric.gauge.data_points.add(time_unix_nano=1793880000123456789, as_int=1)
        metric.metadata.add(key="secret").value.string_value = "metadata-sensitive"
        metric.metadata.add(key="safe").value.string_value = "metadata-retained"
        sys.stdout.buffer.write(request.SerializeToString())
        return
    endpoint = os.environ["METRICS_TEST_HTTP_ENDPOINT"]
    grpc_endpoint = os.environ["METRICS_TEST_GRPC_ENDPOINT"]
    for url in (endpoint, grpc_endpoint):
        parsed = urlsplit(url)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
            raise AssertionError("SDK fixture requires the test's loopback listeners")
    headers = {
        "authorization": os.environ["METRICS_TEST_AUTHORIZATION"],
        "x-glasshouse-project-id": os.environ["METRICS_TEST_PROJECT_ID"],
    }
    transport = os.environ["METRICS_TEST_TRANSPORT"]
    if transport == "http":
        # The official SDK appends /v1/metrics to the generic base endpoint.
        os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint
        exporter = HttpExporter(headers=headers, compression=Compression.Gzip, timeout=5)
    elif transport == "grpc":
        exporter = GrpcExporter(
            endpoint=urlsplit(grpc_endpoint).netloc,
            headers=tuple(headers.items()),
            insecure=True,
            compression=grpc.Compression.Gzip,
            timeout=5,
        )
    else:
        raise AssertionError("Unknown SDK test transport")

    reader = InMemoryMetricReader(
        preferred_temporality={Counter: AggregationTemporality.DELTA}
    )
    provider = MeterProvider(
        resource=Resource({"service.name": "glasshouse-metrics-sdk-regression"}),
        metric_readers=[reader],
    )
    meter = provider.get_meter("glasshouse.metrics.sdk", version="1.0.0")
    prefix = os.environ["METRICS_TEST_PREFIX"]
    attributes = {"sdk.label": "retained", "sdk.enabled": False}
    meter.create_counter(f"{prefix}.counter", unit="1").add(8, attributes)
    meter.create_up_down_counter(f"{prefix}.updown", unit="1").add(-3, attributes)
    histogram = meter.create_histogram(f"{prefix}.histogram", unit="s")
    histogram.record(0.5, attributes)
    histogram.record(1.5, attributes)
    meter.create_observable_gauge(
        f"{prefix}.gauge",
        callbacks=[lambda _: [Observation(0, attributes)]],
    )
    try:
        data = reader.get_metrics_data()
        result = exporter.export(data)
        if result != MetricExportResult.SUCCESS:
            raise AssertionError(f"Official {transport} metrics exporter returned {result}")
        expected = []
        for resource in data.resource_metrics:
            for scope in resource.scope_metrics:
                for metric in scope.metrics:
                    for point in metric.data.data_points:
                        item = {
                            "name": metric.name,
                            "time": str(point.time_unix_nano),
                        }
                        if hasattr(metric.data, "aggregation_temporality"):
                            item["temporality"] = int(metric.data.aggregation_temporality)
                        if hasattr(point, "value"):
                            item["value"] = point.value
                        if hasattr(point, "count"):
                            item["count"] = str(point.count)
                            item["sum"] = point.sum
                            item["buckets"] = [str(n) for n in point.bucket_counts]
                            item["bounds"] = list(point.explicit_bounds)
                        expected.append(item)
        print(json.dumps(expected))
    finally:
        exporter.shutdown()
        provider.shutdown()


if __name__ == "__main__":
    main()
