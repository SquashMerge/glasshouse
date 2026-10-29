#!/usr/bin/env bash

normalize_env_file() (
  set -euo pipefail
  umask 077
  path="$1"
  temporary=""
  trap '[ -z "$temporary" ] || rm -f -- "$temporary"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [ -L "$path" ] || [ ! -f "$path" ]; then
    printf 'Environment normalization requires a regular, non-symlink file.\n' >&2
    exit 1
  fi
  if ! LC_ALL=C grep -q $'\r' -- "$path"; then
    exit 0
  fi

  mode="$(stat -c '%a' -- "$path" 2>/dev/null || stat -f '%Lp' "$path")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || exit 1
  # Preserve owner restrictions without copying group/world access to the new file.
  printf -v mode '%03o' "$(( 8#$mode & 0600 ))"
  temporary="$(mktemp "${path}.normalize.XXXXXX")" || exit 1
  tr -d '\r' < "$path" > "$temporary" || exit 1
  chmod "$mode" "$temporary" || exit 1
  mv -f -- "$temporary" "$path" || exit 1
  temporary=""
)
