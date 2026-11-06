#!/usr/bin/env python3
import argparse
import re
import sys
import xml.etree.ElementTree as ET

REQUIRED_NAMES = {
    "fidelity": [
        "fidelity fixture never connects to an inherited Valkey pub/sub sink",
        "ClickHouse upgrade/replay preserves legacy rows without invented nanos; fresh schema matches",
        *[f"official {transport} SDK fidelity, exact nanos, redaction={redaction}, retry and authenticated tenant denial"
          for transport in ("http", "grpc") for redaction in ("false", "true")],
        "bounded JSON detail preserves counts, precision and every continuation page",
        "revoked ingestion credential cannot persist event/link spans",
    ],
    "logs": [
        "standard JSON logs persist with trusted scope, resource/scope metadata, and exact nanoseconds",
        *[f"official SDK {transport} {suffix}" for transport in ("http", "grpc") for suffix in (
            "log exporter writes real correlated logs",
            "rejects anonymous and cross-Project log exports without writes",
        )],
    ],
    "logs-readback": [
        "log keysets sort UInt64 numerically across decimal widths and reject scope/filter reuse",
        "typed log pages honor their UTF-8 budget and continue without losing retained bodies",
        "ClickHouse rejects physically unscoped logs",
    ],
    "metrics": [
        "metrics has real tenant-bearing ClickHouse storage after the normal migrations",
        "metrics pagination bounds every page and rejects cursors from another Project or filter",
        "metrics reads and cursors use the authorized canonical Project UUID across valid spellings",
        "official protobuf metadata is retained/redacted through HTTP and gRPC rather than silently dropped",
        *[f"official Python SDK {transport} exporter succeeds only after metrics are stored and readable"
          for transport in ("http", "grpc")],
    ],
}


def verify(suite, report):
    root = ET.parse(report).getroot()
    if root.tag not in {"testsuites", "testsuite"}:
        raise ValueError("expected a JUnit test suite")
    for tag in ("skipped", "failure", "error"):
        if next(root.iter(tag), None) is not None:
            raise ValueError(f"report contains {tag}")
    for element in root.iter():
        for attribute in ("skipped", "failures", "errors"):
            if int(element.get(attribute, "0")) != 0:
                raise ValueError(f"report declares {attribute}")
    names = [case.get("name", "") for case in root.iter("testcase")]
    if suite == "process-shutdown":
        required = [re.escape(f"API shuts down HTTP and gRPC on {signal}")
                    for signal in ("SIGTERM", "SIGINT")]
    elif suite == "extension-depth":
        required = [
            rf"public ingest redacts unknown {location} fields \({depth} wrappers, [0-9]+ bytes\)"
            for depth, location in ((100, "value"), (16000, "value"), (20000, "attribute"),
                                    (20000, "value"), (32000, "value"), (80000, "value"))
        ] + [re.escape("deep extensions cannot bypass public authentication, tenant provenance, or body bounds")]
    else:
        required = [re.escape(name) for name in REQUIRED_NAMES[suite]]
    for pattern in required:
        if sum(re.fullmatch(pattern, name) is not None for name in names) != 1:
            raise ValueError(f"required case absent or duplicated: {pattern}")
    print(f"Verified required OTLP {suite} cases ({len(required)} required, {len(names)} total; no skips)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("suite", choices=("extension-depth", "process-shutdown", *REQUIRED_NAMES))
    parser.add_argument("report")
    args = parser.parse_args()
    try:
        verify(args.suite, args.report)
    except (OSError, ValueError, ET.ParseError) as error:
        sys.exit(f"Required OTLP {args.suite} coverage failed: {error}")
