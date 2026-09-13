#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CANONICAL_PATH="${OPENAPI_CANONICAL_PATH:-"$ROOT/openapi.yaml"}"

if [[ ! -f "$CANONICAL_PATH" ]]; then
  printf 'OpenAPI canonical artifact is missing: %s\n' "$CANONICAL_PATH" >&2
  exit 1
fi

output="$(mktemp)"
trap 'rm -f "$output"' EXIT
OPENAPI_SNAPSHOT_PATH="$output" bun run "$ROOT/infra/codegen/snapshot.ts"
if ! cmp -s "$output" "$CANONICAL_PATH"; then
  printf 'OpenAPI canonical artifact is out of date: %s\n' "$CANONICAL_PATH" >&2
  exit 1
fi
