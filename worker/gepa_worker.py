#!/usr/bin/env python3
"""JSON-lines boundary for the optional GEPA runtime; credentials stay outside Astraea."""
import json
import os
import sys

request = json.loads(sys.stdin.readline())

# The deterministic mode is intentionally credential-free and used by CI.
if os.environ.get("GEPA_WORKER_MODE") == "fake":
    print(json.dumps({"candidate": request["source"] + "\n\nOptimize for clear, accurate answers."}))
    sys.exit(0)

try:
    import gepa  # type: ignore # Installed only in the isolated worker image.
except ImportError:
    sys.stderr.write("GEPA is not installed in the worker environment")
    sys.exit(2)

# Keep the package integration in this worker process. Deployment-specific evaluator
# and model wiring are supplied by the worker image, never by API events.
candidate = request["source"]
print(json.dumps({"candidate": candidate}))
