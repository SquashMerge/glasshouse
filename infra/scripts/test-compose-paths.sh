#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
from pathlib import Path

compose = Path("infra/compose.yaml").read_text()
deps_compose = Path("infra/compose.deps.yaml").read_text()
required = (
    "      - ./infra/valkey/valkey.conf:/usr/local/etc/valkey/valkey.conf:ro",
    "      context: .",
    "      ASTRAEA_BOOTSTRAP_OWNER_USERNAME: ${ASTRAEA_BOOTSTRAP_OWNER_USERNAME:?ASTRAEA_BOOTSTRAP_OWNER_USERNAME must be set in infra/.env}",
    "      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-astraea}",
    "      EVALUATION_ALLOWED_MODELS: ${EVALUATION_ALLOWED_MODELS:-openai/gpt-4o-mini}",
    "      EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT: ${EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT:-4}",
    "      EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR: ${EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR:-2}",
    "      EVALUATION_MAX_CASES_PER_RUN: ${EVALUATION_MAX_CASES_PER_RUN:-100}",
    "      EVALUATION_MAX_PROVIDER_CALLS_PER_RUN: ${EVALUATION_MAX_PROVIDER_CALLS_PER_RUN:-100}",
)
for value in required:
    if compose.count(value) != (2 if value == "      context: ." else 1):
        raise SystemExit(f"expected root-project Compose path: {value}")
if "      context: .." in compose or "      - ./valkey/" in compose:
    raise SystemExit("Compose paths must be relative to the repository project directory")
if ":***@" in compose:
    raise SystemExit("Compose DATABASE_URL must interpolate the configured PostgreSQL password")

for name, content in (("infra/compose.yaml", compose), ("infra/compose.deps.yaml", deps_compose)):
    for port in (
        "127.0.0.1:${POSTGRES_PORT:-5432}:5432",
        "127.0.0.1:${CLICKHOUSE_HTTP_PORT:-8123}:8123",
        "127.0.0.1:${CLICKHOUSE_NATIVE_PORT:-9000}:9000",
        "127.0.0.1:${VALKEY_PORT:-6379}:6379",
    ):
        if port not in content:
            raise SystemExit(f"expected loopback-only data-service port binding in {name}: {port}")
PY
