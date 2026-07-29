#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
from pathlib import Path

compose = Path("infra/compose.yaml").read_text()
required = (
    "      - ./infra/valkey/valkey.conf:/usr/local/etc/valkey/valkey.conf:ro",
    "      context: .",
)
for value in required:
    if compose.count(value) != (2 if value == "      context: ." else 1):
        raise SystemExit(f"expected root-project Compose path: {value}")
if "      context: .." in compose or "      - ./valkey/" in compose:
    raise SystemExit("Compose paths must be relative to the repository project directory")
PY
