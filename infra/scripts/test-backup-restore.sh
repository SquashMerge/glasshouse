#!/usr/bin/env bash
# Fast artifact validation and restore-safety gate.

set -euo pipefail
umask 077
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/artifact"
printf '%s\n' '{"format":"glasshouse-backup-v1","backup_id":"current-version-fixture","source_id":"source","created_at":"2026-10-30T00:00:00Z","postgres_server_version":"18.6","clickhouse_server_version":"26.10.2.103","stores":["postgresql","clickhouse"],"files":["postgres.dump","clickhouse.zip","SHA256SUMS"],"complete":true}' > "$tmp/artifact/manifest.json"
printf x > "$tmp/artifact/postgres.dump"
python3 - "$tmp/artifact/clickhouse.zip" <<'PY'
import pathlib
import sys
import zipfile

with zipfile.ZipFile(pathlib.Path(sys.argv[1]), "w") as archive:
    archive.writestr("metadata.txt", "clickhouse backup fixture\n")
PY
(cd "$tmp/artifact" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
BACKUP_ARTIFACT="$tmp/artifact" "$root_dir/infra/scripts/restore.sh" --validate-only >/dev/null
cp "$tmp/artifact/clickhouse.zip" "$tmp/valid-clickhouse.zip"
python3 - "$tmp/artifact/clickhouse.zip" <<'PY'
import pathlib
import sys
import zipfile

with zipfile.ZipFile(pathlib.Path(sys.argv[1]), "w") as archive:
    archive.writestr("metadata.txt", "tampered but valid zip\n")
PY
(cd "$tmp/artifact" && sha256sum postgres.dump > SHA256SUMS)
if BACKUP_ARTIFACT="$tmp/artifact" "$root_dir/infra/scripts/restore.sh" --validate-only >"$tmp/missing-checksum-output" 2>&1; then
	printf 'artifact without a ClickHouse checksum was accepted\n' >&2
	exit 1
fi
if ! grep -q 'checksum' "$tmp/missing-checksum-output"; then
	printf 'missing checksum refusal did not identify the checksum check\n' >&2
	exit 1
fi
cp "$tmp/valid-clickhouse.zip" "$tmp/artifact/clickhouse.zip"
(cd "$tmp/artifact" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
printf z >> "$tmp/artifact/clickhouse.zip"
if BACKUP_ARTIFACT="$tmp/artifact" "$root_dir/infra/scripts/restore.sh" --validate-only >"$tmp/corrupt-output" 2>&1; then
	printf 'corrupt artifact was accepted\n' >&2
	exit 1
fi
(cd "$tmp/artifact" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
printf 'not a zip' > "$tmp/artifact/clickhouse.zip"
if (cd "$tmp/artifact" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS) && BACKUP_ARTIFACT="$tmp/artifact" "$root_dir/infra/scripts/restore.sh" --validate-only >"$tmp/archive-output" 2>&1; then
	printf 'non-ZIP ClickHouse artifact was accepted\n' >&2
	exit 1
fi
python3 - "$tmp/artifact/clickhouse.zip" <<'PY'
import pathlib
import sys
import zipfile

with zipfile.ZipFile(pathlib.Path(sys.argv[1]), "w") as archive:
    archive.writestr("metadata.txt", "clickhouse backup fixture\n")
PY
(cd "$tmp/artifact" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
if RESTORE_TARGET_ID=source RESTORE_CONFIRMATION='RESTORE GLASSHOUSE TO source' BACKUP_ARTIFACT="$tmp/artifact" "$root_dir/infra/scripts/restore.sh" >"$tmp/output" 2>&1; then
	printf 'unsafe target was accepted\n' >&2
 exit 1
fi
if ! grep -q 'differ from source identity' "$tmp/output"; then
	printf 'unsafe target refusal did not identify the source-identity check\n' >&2
	 exit 1
fi
python3 - "$root_dir/infra/scripts/restore.sh" <<'PY'
from pathlib import Path
import sys

restore = Path(sys.argv[1]).read_text()
backup = Path(sys.argv[1]).with_name("backup.sh").read_text()
if ".read_bytes()" in restore or ".read_bytes()" in backup:
    raise SystemExit("backup checksums must stream files instead of loading them into memory")
if "relnamespace = 'public'::regnamespace" in restore:
    raise SystemExit("PostgreSQL empty-target guard is restricted to public")
if "pg_namespace" not in restore or "information_schema" not in restore:
    raise SystemExit("PostgreSQL empty-target guard must inspect user schemas")
if "relkind IN ('r','p','v','m','S','f','c')" not in restore:
    raise SystemExit("PostgreSQL empty-target guard must include all restorable relations")
for catalog in ("pg_proc", "pg_type", "pg_largeobject_metadata"):
    if catalog not in restore:
        raise SystemExit(f"PostgreSQL empty-target guard must include user objects from {catalog}")
if "c.relname = 'pgmigrations'" in restore:
    raise SystemExit("PostgreSQL restore target must reject an existing migration table")
if "name != 'glasshouse_schema_migrations'" in restore:
    raise SystemExit("ClickHouse restore target must reject existing tables")
if 'chown clickhouse:clickhouse "$1" && chmod 600 "$1"' not in restore:
    raise SystemExit("ClickHouse restore archive must be readable only by the ClickHouse user")
if "pg_restore --exit-on-error --single-transaction" not in restore:
    raise SystemExit("PostgreSQL restore must fail fast and roll back on errors")
PY
if grep -Eq -- 'clickhouse-client.*--password' "$root_dir/infra/scripts/backup.sh" "$root_dir/infra/scripts/restore.sh" "$root_dir/infra/scripts/test-backup-restore-integration.sh"; then
	printf 'ClickHouse passwords must not be passed in process arguments\n' >&2
	exit 1
fi
if grep -Fq 'env "PGPASSWORD=' "$root_dir/infra/scripts/backup.sh" "$root_dir/infra/scripts/restore.sh" "$root_dir/infra/scripts/test-backup-restore-integration.sh"; then
	printf 'PostgreSQL passwords must not be passed as docker exec arguments\n' >&2
	exit 1
fi

mkdir -p "$tmp/source/infra" "$tmp/target/infra" "$tmp/bin"
touch "$tmp/source/infra/compose.custom.yaml" "$tmp/target/infra/compose.custom.yaml"
printf 'source-secret\n' > "$tmp/source/production.env"
printf 'target-secret\n' > "$tmp/target/production.env"
cat > "$tmp/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *' config --format json'* ]]; then
    if [[ "$*" == *'--project-name source-custom'* ]]; then
        printf '%s\n' '{"services":{"source-postgres":{"environment":{"POSTGRES_USER":"source_user","POSTGRES_PASSWORD":"source_password","POSTGRES_DB":"source_db"}},"source-clickhouse":{"environment":{"CLICKHOUSE_USER":"source_ch_user","CLICKHOUSE_PASSWORD":"source_ch_password","CLICKHOUSE_DB":"source_ch_db"}}}}'
    else
        printf '%s\n' '{"services":{"target-postgres":{"environment":{"POSTGRES_USER":"target_user","POSTGRES_PASSWORD":"target_password","POSTGRES_DB":"target_db"}},"target-clickhouse":{"environment":{"CLICKHOUSE_USER":"target_ch_user","CLICKHOUSE_PASSWORD":"target_ch_password","CLICKHOUSE_DB":"target_ch_db"}}}}'
    fi
fi
SH
chmod 700 "$tmp/bin/docker"
PATH="$tmp/bin:$PATH" bash -c '
  set -euo pipefail
  source "$1/infra/scripts/backup-restore-common.sh"
  source_compose=(docker compose --project-directory "$2/source" --env-file "$2/source/production.env" --project-name source-custom -f "$2/source/infra/compose.custom.yaml")
  target_compose=(docker compose --project-directory "$2/target" --env-file "$2/target/production.env" --project-name target-custom -f "$2/target/infra/compose.custom.yaml")
  [[ "$(compose_service_value source-postgres POSTGRES_USER "${source_compose[@]}")" == source_user ]]
  [[ "$(compose_service_value source-postgres POSTGRES_PASSWORD "${source_compose[@]}")" == source_password ]]
  [[ "$(compose_service_value source-postgres POSTGRES_DB "${source_compose[@]}")" == source_db ]]
  [[ "$(compose_service_value target-postgres POSTGRES_USER "${target_compose[@]}")" == target_user ]]
  [[ "$(compose_service_value target-postgres POSTGRES_PASSWORD "${target_compose[@]}")" == target_password ]]
  [[ "$(compose_service_value target-clickhouse CLICKHOUSE_DB "${target_compose[@]}")" == target_ch_db ]]
' _ "$root_dir" "$tmp"
mkdir -p "$tmp/secure-bin"
cat > "$tmp/secure-bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\0' "$@" > "$CLICKHOUSE_DOCKER_ARGS"
if [[ "$*" == *'mktemp /tmp/glasshouse-clickhouse-client.XXXXXX'* ]]; then
    printf '%s\n' "$CLICKHOUSE_CONFIG_PATH"
else
    cat > "$CLICKHOUSE_CONFIG_CAPTURE"
fi
SH
chmod 700 "$tmp/secure-bin/docker"
PATH="$tmp/secure-bin:$PATH" CLICKHOUSE_DOCKER_ARGS="$tmp/clickhouse-argv" CLICKHOUSE_CONFIG_CAPTURE="$tmp/clickhouse-client.xml" CLICKHOUSE_CONFIG_PATH=/tmp/glasshouse-clickhouse-client.fixture123 bash -c '
  set -euo pipefail
  source "$1/infra/scripts/backup-restore-common.sh"
  config="$(create_clickhouse_client_config clickhouse fixture-user "fixture<&>password" docker compose --project-name fixture)"
  [[ "$config" == "$CLICKHOUSE_CONFIG_PATH" ]]
' _ "$root_dir"
python3 - "$tmp/clickhouse-argv" "$tmp/clickhouse-client.xml" <<'PY'
from pathlib import Path
import sys

arguments = Path(sys.argv[1]).read_bytes().split(b"\0")
config = Path(sys.argv[2]).read_text()
if any(b"fixture<&>password" in argument for argument in arguments):
    raise SystemExit("ClickHouse password appeared in Docker process arguments")
if "<password>fixture&lt;&amp;&gt;password</password>" not in config:
    raise SystemExit("ClickHouse config did not preserve an XML-escaped password")
if not any(b"chmod 600" in argument for argument in arguments):
    raise SystemExit("ClickHouse client config is not created with mode 0600")
PY
python3 - "$root_dir/infra/scripts/check-restore-mounts.py" <<'PY'
import json
import subprocess
import sys
import tempfile
from pathlib import Path

checker = sys.argv[1]

def check(source, target, should_overlap):
    data = [
        {"Mounts": source},
        {"Mounts": []},
        {"Mounts": target},
        {"Mounts": []},
    ]
    result = subprocess.run(
        [sys.executable, checker],
        input=json.dumps(data),
        text=True,
        capture_output=True,
    )
    if (result.returncode == 0) == should_overlap:
        raise SystemExit(
            f"mount overlap check failed for {source!r} vs {target!r}: "
            f"exit={result.returncode}, stderr={result.stderr}"
        )


def bind(path):
    return {"Type": "bind", "Name": "", "Source": str(path)}

check([bind("/srv/db")], [bind("/srv/db/restore")], True)
check([bind("/srv/db/restore")], [bind("/srv/db")], True)
check([bind("/srv/db")], [bind("/srv/db2")], False)
check(
    [{"Type": "volume", "Name": "glasshouse_data", "Source": "/var/lib/docker/volumes/glasshouse_data/_data"}],
    [{"Type": "volume", "Name": "glasshouse_data", "Source": "/var/lib/docker/volumes/glasshouse_data/_data"}],
    True,
)
check(
    [{"Type": "volume", "Name": "source_data", "Source": "/var/lib/docker/volumes/source_data/_data"}],
    [{"Type": "volume", "Name": "target_data", "Source": "/var/lib/docker/volumes/target_data/_data"}],
    False,
)
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    real = root / "real"
    real.mkdir()
    alias = root / "alias"
    alias.symlink_to(real, target_is_directory=True)
    check([bind(real)], [bind(alias / "restore")], True)
PY
python3 - "$root_dir" <<'PY'
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

root = Path(sys.argv[1])
config_path = root / "infra/clickhouse/backup.xml"
config = ET.parse(config_path).getroot()
expected = {
    "storage_configuration/disks/glasshouse_backups/path": "/var/lib/clickhouse/backup/",
    "backups/allowed_disk": "glasshouse_backups",
    "backups/allowed_path": "/var/lib/clickhouse/backup/",
}
for path, value in expected.items():
    node = config.find(path)
    if node is None or node.text != value:
        raise SystemExit(f"ClickHouse backup config must set {path} to {value}")
mount = "./infra/clickhouse/backup.xml:/etc/clickhouse-server/config.d/glasshouse-backup.xml:ro"
for compose_name in ("infra/compose.yaml", "infra/compose.deps.yaml", ".github/compose.backup-restore.yaml"):
    compose = (root / compose_name).read_text()
    if compose.count(mount) != 1:
        raise SystemExit(f"{compose_name} must mount the restricted ClickHouse backup config exactly once")
PY
python3 -m unittest discover -s "$root_dir/infra/scripts/tests" -p 'test_production_restore_docs.py'
printf 'backup/restore safety checks passed\n'
