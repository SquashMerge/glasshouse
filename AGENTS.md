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

## Terminology

Project vocabulary lives in `docs/04-glossary.md`. When you add a new entity, route, page, stored field, or classification rule, or notice two names being used for the same thing, update the glossary in the same change.

## Comments

Don't add unnecessary comments throughout the codebase. Code should speak for itself. Only comment when the code is complex, easy to misread, hides a non-obvious decision (ordering, race, perf trade-off, pinned contract from a brief), or when a brief/issue requires it. Future readers will thank you for fewer lines.
