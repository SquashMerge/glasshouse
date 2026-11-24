#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 || ! "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[A-Za-z0-9]+([.-][A-Za-z0-9]+)*)?$ ]]; then
  printf 'Expected a version tag such as v1.2.3 or v1.2.3-rc.1\n' >&2
  exit 1
fi
