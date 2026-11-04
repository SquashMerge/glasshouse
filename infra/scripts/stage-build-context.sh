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
while IFS=$' \t' read -r mode _ _ path; do
  [[ "$mode" != 120000 ]] || { printf 'Refusing symlinked build input: %s\n' "$path" >&2; exit 1; }
done < <(git ls-files -s -- "${allowlisted_paths[@]}")

if git diff --quiet -- "${allowlisted_paths[@]}" && git diff --cached --quiet -- "${allowlisted_paths[@]}" && [[ -z "$(git ls-files --others --exclude-standard -- "${allowlisted_paths[@]}")" ]]; then
  git archive --format=tar HEAD -- "${allowlisted_paths[@]}" | tar -x -C "$destination"
else
  while IFS= read -r -d '' path; do
    [[ ! -L "$root/$path" ]] || { printf 'Refusing symlinked build input: %s\n' "$path" >&2; exit 1; }
    mkdir -p -- "$destination/$(dirname -- "$path")"
    cp -p -- "$root/$path" "$destination/$path"
  done < <(git ls-files -z -- "${allowlisted_paths[@]}")
fi
