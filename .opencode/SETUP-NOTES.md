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

## Known quirks

- `minimax` and `minimax-coding-plan` are functionally identical providers (same endpoint, same env, same models). Using `minimax-coding-plan` for the friendly provider label.
- All seven MiniMax models on this endpoint have `reasoning: true`, which maps to the "Thinking" toggle in the chat UI. The `variant` field is harmless if ignored — Gemini/OpenAI providers honor it, but MiniMax's `variant` shape is unknown.
- The M3.7-highspeed model is the cheapest option (~$0 input / $0 output listed in models.dev pricing, but actual costs depend on subscription plan).

## Git identity

- Commits must be authored by `Daniel Sarlo <16106087+dsarlo@users.noreply.github.com>` (the GitHub noreply address). This is pinned via `git config user.email` in the local repo.
- Always verify with `gh api repos/dsarlo/astraea/commits` after any push — every commit's `author.login` should be `dsarlo`. If anything looks wrong, re-author with the procedure in the Hermes session log (do not document it in this repo).

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

## Context7 MCP (added 2026-07-11)

The platform's build agent has live access to up-to-date library docs via Context7 MCP. Agents are auto-instructed via `AGENTS.md` at the repo root to reach for context7 whenever a task touches a library — without needing `use context7` typed manually.

**Config (`~/.config/opencode/opencode.json`):**

```json
"mcp": {
  "context7": {
    "type": "remote",
    "url": "https://mcp.context7.com/mcp",
    "headers": {}
  }
}
```

**What it gives you:**
- Latest API docs for any library (React, Hono, FastAPI, ClickHouse, OpenTelemetry, all the frameworks in our design doc)
- Version-specific code examples (so we get Hono 4.x patterns, not 3.x)
- Server-side instructs the agent to use context7 *even when it thinks it knows the answer* — kills hallucinated APIs

**Smoke test (verified working):**

```bash
cd ~/code/astraea
PATH=/home/hermes/.hermes/node/bin:$PATH opencode run --model "minimax-coding-plan/MiniMax-M2.7-highspeed" \
  "use context7 to fetch the current docs for Hono's Hono() factory function. After fetching, respond with exactly the version number and one line of the doc content."
```

Output observed:

```
⚙ context7_resolve-library-id {"query":"Hono factory function","libraryName":"Hono"}
⚙ context7_query-docs {"libraryId":"/websites/hono_dev","query":"Hono() factory function constructor"}
⚙ context7_query-docs {"libraryId":"/websites/hono_dev","query":"new Hono() constructor"}
⚙ context7_query-docs {"libraryId":"/websites/hono_dev","query":"Hono version number"}
% WebFetch https://hono.dev/docs/api/hono
% WebFetch https://hono.dev
% WebFetch https://hono.dev/docs
% WebFetch https://cdn.jsdelivr.net/npm/hono/package.json
**4.12.29** | The Hono object is the primary entry point for any Hono application.
```

**Optional upgrade:** get an API key from https://context7.com/dashboard for higher rate limits + private libraries, then add `"CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}"` to the `headers` block and export the key.
