# Astraea

**Astraea** is an open-source evaluation platform for AI agents and LLM workflows. It treats your agent as a versioned contract — the manifest captures not just prompts, but the tools, routing rules, guardrails, and dependencies your agent runs with — so every eval run is bound to a known agent version, every regression is bisectable, and every rollback is atomic.

> Named for the Titan goddess of innocence and purity: the idea that an agent eval platform should be honest about what your agent actually is, not just optimistic about what it could be.

**Local dev stack:** Postgres 16 + ClickHouse 24 + [Valkey 8](https://valkey.io) (open-source Redis fork) + Hono + React dashboard, behind `make dev`.

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

Implementation is in progress. The MVP foundation ships via the factory run `phase-1-foundation`: a runnable local stack with Postgres, ClickHouse, Valkey, the Hono backend, and the React dashboard, all behind a single command.

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
nodejs 22.11.0
```

The Postgres, ClickHouse, and Valkey **servers** run in Docker (Compose brings them up). Their CLI clients (`psql`, `clickhouse-client`, `valkey-cli`) are best installed via your OS package manager — see Option B.

Run once after cloning:

```sh
make setup-tools
```

This installs asdf plugins for every tool and installs the pinned versions. Re-run anytime `.tool-versions` changes.

> Note: asdf-managed Postgres / Redis plugins build from source and need a C toolchain (`gcc`) plus `unzip`/`uconv` etc. That's why `.tool-versions` only lists Bun and Node.js — the dev tools the runtime actually needs.

#### Option B — install manually

| Tool | Install |
|---|---|
| Bun | `curl -fsSL https://bun.sh/install \| bash` (or via asdf) |
| Node.js 22 | `nvm install 22` (or via asdf) |
| uv | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Postgres client (`psql`) | `apt-get install postgresql-client` / `brew install libpq` |
| Valkey client (`valkey-cli`) | `apt-get install valkey-tools` / `brew install valkey` |
| ClickHouse client | `curl https://clickhouse.com/ \| sh` (or `brew install clickhouse`) |

`make doctor` checks the minimum versions after install.

### `make dev`

Brings up the full stack (Postgres + ClickHouse + Valkey + Hono API + Vite web) with healthchecks and waits for all services to be ready. Bootstraps the control plane at `.opencode/factory/`.

### Local dev (deps in Docker, api + web via bun)

If you want fast HMR on the api + frontend without rebuilding Docker images on every change, run the data services in Docker and the api + web locally with bun. Open three terminals:

```sh
# Terminal 1: data services only
make deps-up

# Terminal 2: Hono API on localhost:3000 (sources infra/.env, watches apps/api/src)
make dev-backend

# Terminal 3: Vite dev server on localhost:5173 (proxies /v1 -> :3000)
make dev-frontend
```

The local api connects to Postgres / ClickHouse / Valkey on `localhost` (the ports docker compose maps to the host). The Vite dev server proxies `/v1/*`, `/openapi.json`, `/reference`, and `/health` to `localhost:3000`.

Don't run `make dev` and `make deps-up` at the same time — the ports collide.

### URLs after `make dev` (or local workflow)

| URL | Purpose |
|---|---|
| http://localhost:5173 | Dashboard (initial placeholder page) |
| http://localhost:3000/reference | Scalar UI for the typed OpenAPI contract |
| http://localhost:3000/health | Backend health check (Postgres + ClickHouse + Valkey status) |
| http://localhost:3000/openapi.json | OpenAPI 3.1 JSON document |

### `make codegen`

Regenerates the typed TypeScript and Python clients from `openapi.yaml` (which is itself regenerated by `make openapi-snapshot`). Idempotent: running twice produces no diff.

### `make smoke`

Runs the end-to-end smoke (AC1 + AC2 + AC9 + AC10): brings up the stack, curls the health and OpenAPI endpoints, samples stub routes for 501 responses, and runs the Playwright dashboard test (asserts title, links visible, zero console errors during page load).

## Docs

- [`docs/00-explainer.md`](docs/00-explainer.md) — General explainer (the "why" in plain terms)
- [`docs/01-platform-design.md`](docs/01-platform-design.md) — Full technical design (architecture, licensing, integration tiers, deployment, tech stack, REST API)
- [`docs/02-roadmap.md`](docs/02-roadmap.md) — 90-day build plan with Implementation Status
- [`docs/research/`](docs/research/) — Competitive analysis and framework research

## Troubleshooting

**`$'\r': command not found` when running shell scripts** — your checkout has Windows CRLF line endings (Git on Windows defaults to `core.autocrlf=true`). Fix with one of:

```sh
# Re-normalize tracked files in place
make normalize

# Or, after pulling the latest .gitattributes, force git to re-checkout:
git rm --cached infra/scripts/setup-tools.sh infra/scripts/smoke.sh infra/scripts/doctor.sh Makefile
git checkout -- infra/scripts/setup-tools.sh infra/scripts/smoke.sh infra/scripts/doctor.sh Makefile
```

The repo's `.gitattributes` enforces `eol=lf` for `*.sh`, `Makefile`, and all source files so future checkouts normalize correctly.

**`bun` plugin install fails with `unzip: command not found`** — install unzip (`apt-get install unzip` on Debian/Ubuntu, `brew install unzip` on macOS), then `make setup-tools` again.

**`docker compose ... lstat .../infra/apps: no such file or directory`** — older commits used `context: .` in `infra/compose.yaml` which resolved to the compose file's directory; pull the latest commit (≥ `2d585a0`) which uses `context: ..`. If you can't pull, patch compose.yaml manually: change `context: .` to `context: ..` under both `api` and `web` build blocks.

**`asdf plugin add nodejs` fails with "repository does not exist"** — older commits hardcoded bogus plugin URLs. Pull the latest commit (≥ `e8c7755`) which uses `asdf plugin add <name>` (no URL) and lets asdf's plugin index resolve the repo.

**`/health` returns 503 with `valkey: down`** — the valkey container failed healthcheck (probably wrong password or compose started before .env was edited). Run `make doctor` first; if `.env` still has `CHANGE_ME`, edit it and `make dev` again.

**`make dev` warns `The "VALKEY_PASSWORD" variable is not set`** — your `infra/.env` is missing `VALKEY_PASSWORD`. Copy from `infra/.env.example` and edit. The Makefile passes `--env-file infra/.env` to compose; if the file is missing or the var is unset, compose falls back to defaults (warns and uses empty string).

**Local dev (`make dev-backend`) can't connect to Postgres / ClickHouse / Valkey** — `make deps-up` first; it brings the data services up on `localhost:5432 / 8123 / 6379`. If you ran `make dev` (full Docker stack) before, ports may still be bound; run `make down` and then `make deps-up`.

**`/v1/*` requests from the local frontend 404** — make sure `make dev-backend` is running so the Vite proxy has something to forward to. Verify with `curl http://localhost:3000/health`.