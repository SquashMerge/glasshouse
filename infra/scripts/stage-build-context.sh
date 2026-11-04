#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
destination="${1:?usage: stage-build-context.sh DESTINATION}"
readonly -a allowlisted_paths=(
  .dockerignore
  .github/compose.otlp-sdk-integration.yaml
  apps/api
  apps/web
  bun.lock
  infra/clickhouse/backup.xml
  infra/db
  infra/scripts
  package.json
  worker
)

[[ -d "$destination" ]] || { printf '%s\n' 'Build context destination must exist.' >&2; exit 2; }
[[ -z "$(ls -A -- "$destination")" ]] || { printf '%s\n' 'Build context destination must be empty.' >&2; exit 2; }

cd -- "$root"
git diff --quiet HEAD -- && git diff --cached --quiet HEAD -- || {
  printf '%s\n' 'Refusing build context with tracked changes.' >&2
  exit 1
}

while IFS= read -r -d '' entry; do
  case "${entry:0:1}" in
    [a-z])
      printf '%s\n' 'Refusing build context with assume-unchanged tracked files.' >&2
      exit 1
      ;;
  esac
done < <(git ls-files -v -z)

while IFS= read -r -d '' entry; do
  mode="${entry%% *}"
  path="${entry#*$'\t'}"
  [[ "$mode" != 120000 ]] || {
    printf 'Refusing symlinked build input: %s\n' "$path" >&2
    exit 1
  }
done < <(git ls-tree -r -z HEAD -- "${allowlisted_paths[@]}")

git archive --format=tar HEAD -- "${allowlisted_paths[@]}" | tar -x -C "$destination"
