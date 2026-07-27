#!/usr/bin/env bash
# Astraea dev tool installer via asdf.
# Reads .tool-versions and ensures every listed tool is installed with the
# pinned version. Adds missing asdf plugins as needed.
#
# Self-normalizing: if this file (or .tool-versions) was checked out with
# CRLF line endings (Windows + git autocrlf), re-exec through `tr -d '\r'`
# so bash on Linux/macOS can parse it. The .gitattributes in this repo
# enforces LF for *.sh and .tool-versions, but older checkouts may still
# have CRLF until you re-pull + run `make normalize`.
#
# Bash 3.2+ compatible: no associative arrays (`declare -A`) — Apple ships
# bash 3.2.57 as /bin/bash, and `declare -A` is a bash 4 feature. We use
# parallel indexed arrays + a lookup helper instead.
#

# CRLF guard for this script.
if printf '%s' "$0" | grep -q $'\r' 2>/dev/null; then
  TMP="$(mktemp)"
  tr -d '\r' < "$0" > "$TMP"
  chmod +x "$TMP"
  exec bash "$TMP" "$@"
fi

set -euo pipefail

step() { printf '\033[1;34m▶ %s\033[0m\n' "$1"; }
ok() { printf '  \033[1;32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$1"; exit 1; }

cd "$(dirname "$0")/../.."

# Self-normalize .tool-versions if needed.
if [ -f .tool-versions ] && printf '%s' "$(cat .tool-versions)" | grep -q $'\r' 2>/dev/null; then
  step "Stripping CRLF from .tool-versions (Windows checkout detected)"
  tr -d '\r' < .tool-versions > .tool-versions.tmp && mv .tool-versions.tmp .tool-versions
  ok ".tool-versions normalized to LF"
fi

# asdf required.
if ! command -v asdf >/dev/null 2>&1; then
  cat <<'EOF'
✗ asdf not installed.

Install asdf first:
  • macOS (Homebrew): brew install asdf && echo 'source $(brew --prefix asdf)/libexec/asdf.sh' >> ~/.zshrc
  • Linux/macOS (git): git clone https://github.com/asdf-vm/asdf.git ~/.asdf && echo '. ~/.asdf/asdf.sh' >> ~/.bashrc
  • Docs: https://asdf-vm.com/guide/getting-started.html

Then re-run: make setup-tools
EOF
  exit 1
fi
ok "asdf $(asdf --version)"

[ -f .tool-versions ] || fail ".tool-versions not found at repo root"
ok ".tool-versions present"

step "Prerequisites for asdf plugins"
PREREQ_OK=1
if ! command -v unzip >/dev/null 2>&1; then
  echo "  ! unzip not installed. The bun asdf plugin needs it to extract the binary."
  echo "    Install with: apt-get install unzip  (or: brew install unzip)"
  PREREQ_OK=0
fi
if ! command -v gcc >/dev/null 2>&1; then
  echo "  ! gcc not installed. Some asdf plugins (e.g., postgres, erlang) build from source and need a C toolchain."
  echo "    Install with: apt-get install build-essential"
fi
if [ "$PREREQ_OK" = "1" ]; then
  ok "prerequisites present"
else
  echo "  ⚠ Some prerequisites missing; install them before the bun plugin install step below."
fi

# Read pinned versions from .tool-versions (skip comments / blanks).
# We use parallel indexed arrays (TOOLS / VERSIONS) instead of an associative
# array so this script works under bash 3.2 (Apple's /bin/bash).
TOOLS=()
VERSIONS=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="$(echo "$line" | xargs || true)"
  [ -z "$line" ] && continue
  tool="${line%% *}"
  version="${line#* }"
  TOOLS+=("$tool")
  VERSIONS+=("$version")
done < .tool-versions

# Fallback URLs for plugins that aren't in asdf's index. Parallel arrays keyed
# by index (not name) so we don't need associative arrays. Keep first-party
# plugins explicit too: this works with asdf versions whose plugin index is
# unavailable or does not include nodejs.
FALLBACK_TOOL=("bun" "nodejs")
FALLBACK_URL=("https://github.com/axetroy/asdf-bun.git" "https://github.com/asdf-vm/asdf-nodejs.git")

# Returns the fallback URL for a given tool, or empty string.
get_fallback_url() {
  local tool="$1"
  local i
  for i in "${!FALLBACK_TOOL[@]}"; do
    if [ "${FALLBACK_TOOL[$i]}" = "$tool" ]; then
      echo "${FALLBACK_URL[$i]}"
      return 0
    fi
  done
  echo ""
}

step "Ensuring asdf plugins are installed"
i=0
while [ "$i" -lt "${#TOOLS[@]}" ]; do
  tool="${TOOLS[$i]}"
  version="${VERSIONS[$i]}"
  i=$((i + 1))

  if asdf plugin list 2>/dev/null | grep -qx "$tool"; then
    ok "plugin $tool already added"
    continue
  fi

  # Try asdf's plugin index first (no URL argument).
  if asdf plugin add "$tool" 2>/dev/null; then
    ok "added plugin $tool (from asdf index)"
    continue
  fi

  # Try fallback URL if known.
  fallback="$(get_fallback_url "$tool")"
  if [ -n "$fallback" ]; then
    if asdf plugin add "$tool" "$fallback" 2>/dev/null; then
      ok "added plugin $tool (from $fallback)"
      continue
    fi
  fi

  echo "  ! failed to add plugin $tool; skipping"
  echo "    If you know the plugin URL, run: asdf plugin add $tool <url>"
done

step "Installing pinned tool versions"
INSTALL_OK=1
i=0
while [ "$i" -lt "${#TOOLS[@]}" ]; do
  tool="${TOOLS[$i]}"
  version="${VERSIONS[$i]}"
  i=$((i + 1))

  if ! asdf plugin list 2>/dev/null | grep -qx "$tool"; then
    continue  # already logged in the previous step
  fi
  if asdf list "$tool" 2>/dev/null | grep -qx "$version"; then
    ok "$tool $version already installed"
    continue
  fi
  if asdf install "$tool" "$version" 2>&1; then
    ok "installed $tool $version"
  else
    echo "  ! failed to install $tool $version"
    INSTALL_OK=0
  fi
done

step "Reshimming"
asdf reshim >/dev/null 2>&1 || true
ok "reshim complete"

step "Verifying"
ACTUAL_BUN="$(asdf exec bun --version 2>/dev/null || echo 'not installed')"
ACTUAL_NODE="$(asdf exec node --version 2>/dev/null || echo 'not installed')"
echo "  bun:     $ACTUAL_BUN"
echo "  node:    $ACTUAL_NODE"

if [ "$INSTALL_OK" = "1" ]; then
  printf '\n\033[1;32m✓ Tools installed.\033[0m Next: \`make doctor\` then \`make dev\`.\n'
else
  printf '\n\033[1;33m⚠ Some tools failed to install.\033[0m See messages above. Re-run after fixing the failures.\n'
  exit 2
fi