#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
venv="$(mktemp -d)"
home="$(mktemp -d)"
trap 'rm -rf -- "$venv" "$home"' EXIT

env -i PATH="$PATH" HOME="$home" PIP_CONFIG_FILE=/dev/null \
  python3 -m venv "$venv"
env -i PATH="$PATH" HOME="$home" PIP_CONFIG_FILE=/dev/null \
  "$venv/bin/pip" install --disable-pip-version-check --no-input --require-hashes --no-deps -r "$root/infra/otlp-sdk-requirements.txt"
env -i PATH="$PATH" HOME="$home" PIP_CONFIG_FILE=/dev/null \
  "$venv/bin/pip" check
env -i PATH="$PATH" HOME="$home" \
  "$venv/bin/python" "$root/infra/scripts/test-otlp-sdk-offline.py"
