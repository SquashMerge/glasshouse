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
printf 'backup/restore safety checks passed\n'
