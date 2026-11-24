#!/usr/bin/env python3
"""Verify the pinned official OTLP SDK can construct and export without a network."""

import importlib.util
import pathlib
import socket
from unittest.mock import patch

from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult


class RecordingExporter:
    def __init__(self):
        self.spans = []

    def export(self, spans):
        self.spans.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self):
        pass

    def force_flush(self, timeout_millis=30000):
        return True


def main() -> None:
    integration = pathlib.Path(__file__).with_name("otlp-sdk-integration.py")
    specification = importlib.util.spec_from_file_location("otlp_sdk_integration", integration)
    if specification is None or specification.loader is None:
        raise AssertionError("could not load OTLP SDK integration module")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)

    exporter = RecordingExporter()
    with patch.object(socket, "create_connection", side_effect=AssertionError("network access")):
        provider = module.create_tracer_provider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        with provider.get_tracer("glasshouse.otlp.offline").start_as_current_span("offline-span"):
            pass
        if not provider.force_flush():
            raise AssertionError("SDK provider did not flush")
        provider.shutdown()

    if provider.resource.attributes.get("service.name") != "glasshouse-otlp-sdk-test":
        raise AssertionError("SDK provider lost the service resource")
    if [span.name for span in exporter.spans] != ["offline-span"]:
        raise AssertionError("SDK did not export the expected span")


if __name__ == "__main__":
    main()
