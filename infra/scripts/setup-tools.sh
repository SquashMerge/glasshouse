#!/usr/bin/env bash
# Astraea dev tool installer via asdf.
# Reads .tool-versions and ensures every listed tool is installed with the
# pinned version. Adds missing asdf plugins as needed.
#
# Self-normalizing: if this file was checked out with CRLF line endings
# (Windows + git autocrlf), re-exec through `tr -d '\r'` so bash on Linux/macOS
# can parse it. The .gitattributes in this repo enforces LF for *.sh, but
# older checkouts may still have CRLF until you re-pull.
#

# CRLF guard: re-exec through a normalized copy if any \r is present.
if grep -q $'\r' "$0" 2>/dev/null; then
  TMP="$(mktemp)"
  tr -d '\r' < "$0" > "$TMP"
  chmod +x "$TMP"
  exec bash "$TMP" "$@"
fi
# Idempotent: safe to re-run. Skips already-installed tools.

set -euo pipefail

step() { printf '\033[1;34m▶ %s\033[0m\n' "$1"; }
ok() { printf '  \033[1;32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$1"; exit 1; }

cd "$(dirname "$0")/../.."

# asdf required
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

# Plugin repo map. Keys are asdf tool names; values are plugin repos.
# Format: <tool>:<repo>
declare -a PLUGIN_SPECS=(
  "bun:asdf-community/asdf-bun"
  "nodejs:asdf-vm/asdf-nodejs"
  "uv:virtualroot/asdf-uv"
  "postgres:asdf-community/asdf-postgres"
  "redis:asdf-community/asdf-redis"
  "clickhouse:IFanRolll/asdf-clickhouse"
)

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

step "Ensuring asdf plugins are installed"
for spec in "${PLUGIN_SPECS[@]}"; do
  tool="${spec%%:*}"
  repo="${spec##*:}"
  if asdf plugin list 2>/dev/null | grep -qx "$tool"; then
    ok "plugin $tool already added"
  else
    if asdf plugin add "$tool" "$repo" 2>&1; then
      ok "added plugin $tool"
    else
      echo "  ! failed to add $tool from $repo; skipping"
    fi
  fi
done

step "Installing pinned tool versions"
INSTALL_OK=1
for tool in "${!WANT[@]}"; do
  version="${WANT[$tool]}"
  if ! asdf plugin list 2>/dev/null | grep -qx "$tool"; then
    echo "  ! skip $tool (plugin missing)"
    continue
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
ACTUAL_UV="$(asdf exec uv --version 2>/dev/null || echo 'not installed')"
echo "  bun:  $ACTUAL_BUN"
echo "  uv:   $ACTUAL_UV"

if [ "$INSTALL_OK" = "1" ]; then
  printf '\n\033[1;32m✓ Tools installed.\033[0m Next: \`make doctor\` then \`make dev\`.\n'
else
  printf '\n\033[1;33m⚠ Some tools failed to install.\033[0m See messages above. Re-run after fixing the failures.\n'
  exit 2
fi