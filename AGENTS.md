# AGENTS.md — repo-level rules

This file is auto-loaded by OpenCode agents working in this repo.

## Library documentation

When you need library/framework/API documentation, code examples, or setup steps, **automatically use the `context7` MCP tools** to resolve the library id and pull current docs. Do not wait to be told.

Shorthand: if a task touches a library (OpenAI SDK, Anthropic SDK, React, Hono, FastAPI, ClickHouse, OpenTelemetry, etc.), reach for context7 first instead of relying on training-data recall.

## Git identity

- Author and committer: `Daniel Sarlo <16106087+dsarlo@users.noreply.github.com>`
- Always verify with `gh api repos/dsarlo/astraea/commits | python3 -m json.tool` after any push if you're unsure whether the push was attributed to the right account.

## Repo conventions

- License: MIT (see LICENSE)
- Branch: `main` (force-push with `--force-with-lease`)
- Don't introduce additional git remotes without asking.
