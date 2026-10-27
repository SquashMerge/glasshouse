#!/usr/bin/env bash
# Fast artifact validation and restore-safety gate.

set -euo pipefail
umask 077
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/artifact"
printf '%s\n' '{"format":"glasshouse-backup-v1","source_id":"source","stores":["postgresql","clickhouse"],"complete":true}' > "$tmp/artifact/manifest.json"
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
if "relnamespace = 'public'::regnamespace" in restore:
    raise SystemExit("PostgreSQL empty-target guard is restricted to public")
if "pg_namespace" not in restore or "information_schema" not in restore:
    raise SystemExit("PostgreSQL empty-target guard must inspect user schemas")
if "relkind IN ('r','p','v','m','S','f','c')" not in restore:
    raise SystemExit("PostgreSQL empty-target guard must include all restorable relations")
for catalog in ("pg_proc", "pg_type", "pg_largeobject_metadata"):
    if catalog not in restore:
        raise SystemExit(f"PostgreSQL empty-target guard must include user objects from {catalog}")
PY
if grep -Eq -- 'clickhouse-client.*--password' "$root_dir/infra/scripts/backup.sh" "$root_dir/infra/scripts/restore.sh"; then
	printf 'ClickHouse passwords must not be passed in process arguments\n' >&2
	exit 1
fi
if grep -Fq 'env "PGPASSWORD=$pg_password"' "$root_dir/infra/scripts/backup.sh" "$root_dir/infra/scripts/restore.sh"; then
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
printf 'backup/restore safety checks passed\n'
