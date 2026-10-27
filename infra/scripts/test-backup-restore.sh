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
printf x > "$tmp/artifact/clickhouse.zip"
(cd "$tmp/artifact" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
BACKUP_ARTIFACT="$tmp/artifact" "$root_dir/infra/scripts/restore.sh" --validate-only >/dev/null
printf z >> "$tmp/artifact/clickhouse.zip"
if BACKUP_ARTIFACT="$tmp/artifact" "$root_dir/infra/scripts/restore.sh" --validate-only >"$tmp/corrupt-output" 2>&1; then
	printf 'corrupt artifact was accepted\n' >&2
	exit 1
fi
(cd "$tmp/artifact" && sha256sum postgres.dump clickhouse.zip > SHA256SUMS)
if RESTORE_TARGET_ID=source RESTORE_CONFIRMATION='RESTORE GLASSHOUSE TO source' BACKUP_ARTIFACT="$tmp/artifact" "$root_dir/infra/scripts/restore.sh" >"$tmp/output" 2>&1; then
	printf 'unsafe target was accepted\n' >&2
	exit 1
fi
if ! grep -q 'differ from source identity' "$tmp/output"; then
	printf 'unsafe target refusal did not identify the source-identity check\n' >&2
	exit 1
fi
printf 'backup/restore safety checks passed\n'
