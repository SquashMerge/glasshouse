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

# CRLF guard for this script.
if grep -q $'\r' "$0" 2>/dev/null; then
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
if [ -f .tool-versions ] && grep -q $'\r' .tool-versions; then
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

# Read pinned versions from .tool-versions (skip comments / blanks).
declare -A WANT
while IFS= read -r line; do
  line="${line%%#*}"
  line="$(echo "$line" | xargs || true)"
  [ -z "$line" ] && continue
  tool="${line%% *}"
  version="${line#* }"
  WANT["$tool"]="$version"
done < .tool-versions

# Tools that have no asdf plugin at all (uv, clickhouse) are NOT listed in
# .tool-versions — install them via their official installers (see README).
# For tools that DO have asdf plugins, `asdf plugin add <name>` (no URL)
# resolves via asdf's plugin index. Only fall back to a manual git URL when
# the index lookup fails AND we have a known repo.

declare -A FALLBACK_URLS=(
  [bun]="https://github.com/axetroy/asdf-bun.git"
)

step "Ensuring asdf plugins are installed"
for tool in "${!WANT[@]}"; do
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
  fallback="${FALLBACK_URLS[$tool]:-}"
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
for tool in "${!WANT[@]}"; do
  version="${WANT[$tool]}"
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

step "Prerequisites for asdf plugins"
if ! command -v unzip >/dev/null 2>&1; then
  echo "  ! unzip not installed. The bun asdf plugin needs it to extract the binary."
  echo "    Install with: apt-get install unzip  (or: brew install unzip)"
fi
if ! command -v gcc >/dev/null 2>&1; then
  echo "  ! gcc not installed. Some asdf plugins (e.g., postgres, erlang) build from source and need a C toolchain."
  echo "    Install with: apt-get install build-essential"
fi
ok "prerequisites checked"

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