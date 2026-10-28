#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
from pathlib import Path
import xml.etree.ElementTree as ET

compose = Path("infra/compose.yaml").read_text()
deps_compose = Path("infra/compose.deps.yaml").read_text()
production_compose = Path("infra/compose.production.yaml").read_text()
required = (
    "      - ./infra/valkey/valkey.conf:/usr/local/etc/valkey/valkey.conf:ro",
    "      context: .",
    "      GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: ${GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME:?GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME must be set in infra/.env}",
    "      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-glasshouse}",
    "      EVALUATION_ALLOWED_MODELS: ${EVALUATION_ALLOWED_MODELS:-openai/gpt-4o-mini}",
    "      EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT: ${EVALUATION_MAX_ACTIVE_RUNS_PER_PROJECT:-4}",
    "      EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR: ${EVALUATION_MAX_ACTIVE_RUNS_PER_ACTOR:-2}",
    "      EVALUATION_MAX_REQUESTED_SAMPLE_SIZE_PER_RUN: ${EVALUATION_MAX_REQUESTED_SAMPLE_SIZE_PER_RUN:-100}",
    "      EVALUATION_MAX_PROVIDER_CALLS_PER_RUN: ${EVALUATION_MAX_PROVIDER_CALLS_PER_RUN:-100}",
)
for value in required:
    if compose.count(value) != (2 if value == "      context: ." else 1):
        raise SystemExit(f"expected root-project Compose path: {value}")
if "      context: .." in compose or "      - ./valkey/" in compose:
    raise SystemExit("Compose paths must be relative to the repository project directory")
backup_mount = "      - ./infra/clickhouse/backup.xml:/etc/clickhouse-server/config.d/glasshouse-backup.xml:ro"
if production_compose.count(backup_mount) != 1:
    raise SystemExit("production Compose must mount the restricted ClickHouse backup configuration")
backup_config = ET.parse("infra/clickhouse/backup.xml").getroot()
for path, value in (
    ("storage_configuration/disks/glasshouse_backups/path", "/var/lib/clickhouse/backup/"),
    ("backups/allowed_disk", "glasshouse_backups"),
    ("backups/allowed_path", "/var/lib/clickhouse/backup/"),
):
    node = backup_config.find(path)
    if node is None or node.text != value:
        raise SystemExit(f"ClickHouse backup config must set {path} to {value}")

for name, content in (("infra/compose.yaml", compose), ("infra/compose.deps.yaml", deps_compose)):
    for port in (
        "127.0.0.1:${POSTGRES_PORT:-5432}:5432",
        "127.0.0.1:${CLICKHOUSE_HTTP_PORT:-8123}:8123",
        "127.0.0.1:${CLICKHOUSE_NATIVE_PORT:-9000}:9000",
        "127.0.0.1:${VALKEY_PORT:-6379}:6379",
    ):
        if port not in content:
            raise SystemExit(f"expected loopback-only data-service port binding in {name}: {port}")
if ":***@" in compose:
    raise SystemExit("Compose DATABASE_URL must interpolate the configured PostgreSQL password")
PY
