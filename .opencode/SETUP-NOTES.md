# Astraea — opencode + feature-factory setup

**Configured:** 2026-07-11

## What's installed

- **opencode CLI** v1.17.18 → `~/.opencode/bin/opencode`
- **opencode-feature-factory** v0.2.0 → `/home/hermes/.hermes/node/lib/node_modules/opencode-feature-factory` (symlink to `/tmp/opencode-feature-factory` for live dev)
- **opencode config** → `~/.config/opencode/opencode.json` (also `opencode.jsonc` — doctor checks both)
- **provider auth** → `~/.local/share/opencode/auth.json` (mode `0600`)

## Provider

- **ID:** `minimax-coding-plan`
- **Endpoint:** `https://api.minimax.io/anthropic/v1` (Anthropic-compatible)
- **API key env var:** `MINIMAX_API_KEY` (sourced from `/home/hermes/.hermes/.env`)

## Model profile (13 agents)

### High-strength (M3 flagship — planning + validation)
- `feature-factory` → MiniMax-M3 @ xhigh
- `spec-writer` → MiniMax-M3 @ xhigh
- `work-decomposer` → MiniMax-M3 @ xhigh
- `implementation-validator` → MiniMax-M3 @ xhigh
- `security-reviewer` → MiniMax-M3 @ xhigh

### Standard (M3 — building, designing, reviewing)
- `backend-builder` → MiniMax-M3 @ high
- `frontend-builder` → MiniMax-M3 @ high
- `design-interpreter` → MiniMax-M3 @ high
- `codebase-researcher` → MiniMax-M3 @ high
- `test-verifier` → MiniMax-M3 @ high
- `work-reviewer` → MiniMax-M3 @ high

### Cheap (M2.7-highspeed — non-critical reads)
- `story-reader` → MiniMax-M2.7-highspeed @ medium
- `story-writer` → MiniMax-M2.7-highspeed @ high

## Verifying

```bash
cd ~/code/astraea
PATH=/home/hermes/.hermes/node/bin:$PATH feature-factory doctor --provider-smoke
# Should show: "ok: provider minimax-coding-plan smoke (smoke passed)"
```

The doctor reports two "missing" lines that are non-blocking and expected:

1. `factory permissions non-interactive` — auto-seeded on first `factory start` per the README
2. `provider auth` — cosmetic stale-state (real auth works; smoke test proves it)

## Known quirks

- `minimax` and `minimax-coding-plan` are functionally identical providers (same endpoint, same env, same models). Using `minimax-coding-plan` for the friendly provider label.
- All seven MiniMax models on this endpoint have `reasoning: true`, which maps to the "Thinking" toggle in the chat UI. The `variant` field is harmless if ignored — Gemini/OpenAI providers honor it, but MiniMax's `variant` shape is unknown.
- The M3.7-highspeed model is the cheapest option (~$0 input / $0 output listed in models.dev pricing, but actual costs depend on subscription plan).

## Local clone

- `~/code/astraea/` is the work tree
- Branch: `main` (renamed from default during first push)
- Push: `git push origin main` (auth via `gh auth status`, 403 on repo creation but works for clone/push)

## Next steps (when ready to start a feature)

```bash
cd ~/code/astraea
PATH=/home/hermes/.hermes/node/bin:$PATH opencode          # launch TUI
# or
PATH=/home/hermes/.hermes/node/bin:$PATH feature-factory start "description of feature"
```
