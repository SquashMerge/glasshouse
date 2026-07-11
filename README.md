# Astraea

**Astraea** is an open-source evaluation platform for AI agents and LLM workflows. It treats your agent as a versioned contract — the manifest captures not just prompts, but the tools, routing rules, guardrails, and dependencies your agent runs with — so every eval run is bound to a known agent version, every regression is bisectable, and every rollback is atomic.

> Named for the Titan goddess of innocence and purity: the idea that an agent eval platform should be honest about what your agent actually is, not just optimistic about what it could be.

## Why it exists

AI teams in 2026 are building agents that are mostly glue code. A typical production agent looks like this:

```
User message
    ↓
[ Routing layer: premium tier → claude-opus; else → gpt-4o-mini ]
    ↓
[ Prompt template v7 (system + 5KB of conditional context) ]
    ↓
[ Tool call: search_db with RLS, returns 10 results ]
    ↓
[ Re-ranker with custom scoring ]
    ↓
[ Synthesizer (different model, different prompt) ]
    ↓
[ Output guardrail: PII redaction + length cap + refusal rules ]
    ↓
[ Send via email API ]
```

The LLM call is maybe 30% of the actual behavior. The other 70% is routing, tools, prompts, guardrails, and business logic — all of which change independently and can regress independently.

Most eval platforms measure only the LLM call. **Astraea** measures the whole agent as one versioned unit.

## What it does (in plain terms)

1. **Point Astraea at your agent** — one-line SDK call for any framework (Agno, LangGraph, CrewAI, Pydantic AI, Mastra, Vercel AI SDK, etc.), HTTP endpoint registration for black-box, or hand-authored YAML for governance workflows
2. **It captures the manifest** — prompts, models, tools, knowledge, storage, routing rules, guardrails, dependencies, all as a versioned artifact
3. **You run evals** — programmatically via SDK, from CI via GitHub Action, or from the dashboard with no code. Watch results stream live via Server-Sent Events.
4. **It catches things other platforms miss** — drift between trace and manifest, regressions caused by tool-config changes hidden under prompt changes, atomic rollback of the whole agent unit (not just the prompt)

## What makes it different

| | Langfuse | Braintrust | LangSmith | Maxim | Helicone | **Astraea** |
|---|---|---|---|---|---|---|
| Real-agent execution (not re-implementation) | ⚠ | ⚠ | ✅ | ✅ | ❌ | ✅ |
| Agent as typed first-class entity | ❌ | ❌ | ⚠ | ❌ | ❌ | ✅ |
| Manifest version binding on eval runs | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Multi-tenant Agent registry | ❌ | ⚠ | ⚠ | ⚠ | ❌ | ✅ |
| Drift detection (trace vs manifest) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Atomic manifest rollback | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Compatible with any framework (OTLP + OpenAI-compat) | ⚠ | ⚠ | ❌ | ⚠ | ⚠ | ✅ |
| MIT-licensed + single-binary dev mode | ⚠ | ❌ | ❌ | ❌ | ⚠ | ✅ |

**The four pillars nobody else has together:**
1. Real-agent execution (calls your deployed agent, not a re-implementation)
2. Version binding (every eval pinned to a specific manifest version with diffs)
3. Multi-tenant Agent registry (typed entity with versions, environments, history)
4. Drift detection (manifest as "expected behavior" oracle)

## License

MIT core. Sealed `enterprise/` wheel under a custom EULA for premium features (SSO, RBAC, AI-assisted eval suggestions, SOC2 evidence packs).

## Status

Implementation is in progress. The MVP foundation ships via the factory run `phase-1-foundation`: a runnable local stack with Postgres, ClickHouse, Redis, the Hono backend, and the React dashboard, all behind a single command.

## Quick Start

### Prerequisites

- Docker (with Compose v2.13+ for `depends_on condition: service_healthy`)
- Bun 1.1+ (replaces both the package manager and the runtime; install from [bun.sh](https://bun.sh))
- uv (for the Python codegen client; install from [docs.astral.sh/uv](https://docs.astral.sh/uv/))

On Apple Silicon (M-series) the ClickHouse image is pinned to `platform: linux/amd64` for compatibility.

#### Option A — automatic install via asdf

If you use [asdf](https://asdf-vm.com/), the repo's `.tool-versions` pins the asdf-managed dev tools at the versions the project was built against:

```
bun 1.1.42
nodejs 22.10.2
postgres 16.6
redis 7.4.1
```

Run once after cloning:

```sh
make setup-tools
```

This installs asdf plugins for every tool and installs the pinned versions. Re-run anytime `.tool-versions` changes.

#### Option B — install manually

`uv` and the `clickhouse` client are **not** in `.tool-versions` because they don't have asdf plugins — install them with their official installers:

| Tool | Install |
|---|---|
| Bun | `curl -fsSL https://bun.sh/install \| bash` (or via asdf) |
| Node.js 22 | `nvm install 22` (or via asdf) |
| uv | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Postgres client | `brew install postgresql@16` (or via asdf) |
| Redis client | `brew install redis` (or via asdf) |
| ClickHouse client | `curl https://clickhouse.com/ \| sh` (or `brew install clickhouse`) |

`make doctor` checks the minimum versions after install.

### `make dev`

Brings up the full stack (Postgres + ClickHouse + Redis + Hono API + Vite web) with healthchecks and waits for all services to be ready. Bootstraps the control plane at `.opencode/factory/`.

### URLs after `make dev`

| URL | Purpose |
|---|---|
| http://localhost:5173 | Dashboard (initial placeholder page) |
| http://localhost:3000/reference | Scalar UI for the typed OpenAPI contract |
| http://localhost:3000/health | Backend health check (Postgres + ClickHouse + Redis status) |
| http://localhost:3000/openapi.json | OpenAPI 3.1 JSON document |

### `make codegen`

Regenerates the typed TypeScript and Python clients from `openapi.yaml` (which is itself regenerated by `make openapi-snapshot`). Idempotent: running twice produces no diff.

### `make smoke`

Runs the end-to-end smoke (AC1 + AC2 + AC9 + AC10): brings up the stack, curls the health and OpenAPI endpoints, samples stub routes for 501 responses, and runs the Playwright dashboard test (asserts title, links visible, zero console errors during page load).

### Pointers

- [`docs/00-explainer.md`](docs/00-explainer.md) — General explainer (the "why" in plain terms)
- [`docs/01-platform-design.md`](docs/01-platform-design.md) — Full technical design (architecture, licensing, integration tiers, deployment, tech stack, REST API)
- [`docs/02-roadmap.md`](docs/02-roadmap.md) — 90-day build plan
- [`docs/research/`](docs/research/) — Competitive analysis and framework research

### Troubleshooting

**`$'\r': command not found` when running shell scripts** — your checkout has Windows CRLF line endings (Git on Windows defaults to `core.autocrlf=true`). Fix with one of:

```sh
# Re-normalize tracked files in place
make normalize

# Or, after pulling the latest .gitattributes, force git to re-checkout:
git rm --cached infra/scripts/setup-tools.sh infra/scripts/smoke.sh infra/scripts/doctor.sh Makefile
git checkout -- infra/scripts/setup-tools.sh infra/scripts/smoke.sh infra/scripts/doctor.sh Makefile
```

The repo's `.gitattributes` enforces `eol=lf` for `*.sh`, `Makefile`, and all source files so future checkouts normalize correctly.

## Docs

- `docs/00-explainer.md` — General explainer (the "why" in plain terms)
- `docs/01-platform-design.md` — Full technical design (architecture, licensing, integration tiers, trace replay, prompt management, deployment/GitOps, tech stack, trace search, REST API)
- `docs/02-roadmap.md` — 90-day build plan
- `docs/research/` — Competitive analysis and framework research backing the design decisions
