#!/usr/bin/env python3
import argparse
import re
import sys
import xml.etree.ElementTree as ET


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
    else:
        required = [
            rf"public ingest redacts unknown {location} fields \({depth} wrappers, [0-9]+ bytes\)"
            for depth, location in ((100, "value"), (16000, "value"), (20000, "attribute"),
                                    (20000, "value"), (32000, "value"), (80000, "value"))
        ] + [re.escape("deep extensions cannot bypass public authentication, tenant provenance, or body bounds")]
    for pattern in required:
        if sum(re.fullmatch(pattern, name) is not None for name in names) != 1:
            raise ValueError(f"required case absent or duplicated: {pattern}")
    print(f"Verified required OTLP {suite} cases ({len(required)} required, {len(names)} total; no skips)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("suite", choices=("extension-depth", "process-shutdown"))
    parser.add_argument("report")
    args = parser.parse_args()
    try:
        verify(args.suite, args.report)
    except (OSError, ValueError, ET.ParseError) as error:
        sys.exit(f"Required OTLP {args.suite} coverage failed: {error}")
