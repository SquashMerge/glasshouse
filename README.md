# Astraea

**Astraea** is an open-source evaluation platform for AI agents and LLM workflows. It treats your agent as a versioned contract — the manifest captures not just prompts, but the tools, routing rules, guardrails, and dependencies your agent runs with — so every eval run is bound to a known agent version, every regression is bisectable, and every rollback is atomic.

> Named for the Titan goddess of precision: the idea that an agent eval platform should be honest about what your agent actually is, not just optimistic about what it could be.

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
| http://localhost:5173/login | Sign in (Basic Auth) |
| http://localhost:5173 | Dashboard (auth-gated; redirects to /login if not signed in) |
| http://localhost:5173/traces | Trace list (auth-gated) |
| http://localhost:5173/traces/:id | Trace detail with span tree (auth-gated) |
| http://localhost:3000/v1/otel/v1/traces | OTLP HTTP/JSON trace ingest (auth-gated; OTel SDK target) |
| http://localhost:3000/reference | Scalar UI for the typed OpenAPI contract (public) |
| http://localhost:3000/health | Backend health check (public; no auth) |
| http://localhost:3000/openapi.json | OpenAPI 3.1 JSON document (public) |

### GEPA prompt optimization and LLM providers

Prompt optimization uses the Python GEPA worker and requires access to an LLM for both candidate evaluation (`task_lm`) and reflection/proposal (`reflection_lm`). The dashboard asks for those two model identifiers when optimization starts; it does not collect or persist API keys. The identifiers are pinned into the job configuration and must be present in `GEPA_ALLOWED_MODELS`.

For direct provider access, inject the provider credential into the API/worker environment and allow the exact model identifiers, for example:

```sh
GEPA_ALLOWED_MODELS=openai/gpt-4o-mini,openai/gpt-4o
OPENAI_API_KEY=your-key-here
```

or:

```sh
GEPA_ALLOWED_MODELS=anthropic/claude-sonnet-4-20250514
ANTHROPIC_API_KEY=your-key-here
```

GEPA accepts provider-prefixed model names through its default adapter. Common LiteLLM-compatible providers include OpenAI, Anthropic, Google/Gemini, Azure OpenAI, and AWS Bedrock; the exact model format and required environment variables are provider-specific and must be supported by the installed GEPA/LiteLLM stack. Astraea does not currently maintain a provider catalog or model discovery endpoint.

An OpenAI-compatible LiteLLM proxy can be used by pointing the worker's OpenAI adapter at the proxy and supplying the proxy credential as the OpenAI key, for example:

```sh
GEPA_ALLOWED_MODELS=openai/my-proxy-model
OPENAI_API_BASE=https://litellm.example.com/v1
OPENAI_API_KEY=your-proxy-key
```

The current UI exposes model names and the metric-call budget, but not provider credentials, proxy administration, connection testing, or model discovery. Never commit these credentials or store them in prompt/job records. For Docker Compose, place them in the gitignored `infra/.env`; for production, use the deployment secret mechanism. `GEPA_WORKER_MODE=fake` is only for deterministic tests and does not perform LLM calls.

#### Development-only local CLI authentication

For local development, `GEPA_WORKER_MODE=cli` makes GEPA call a locally authenticated LLM CLI instead of a provider API key. For example, install and authenticate the OpenAI Codex CLI on the developer machine:

```sh
npm install -g @openai/codex
codex login
export GEPA_WORKER_MODE=cli
export GEPA_ALLOWED_MODELS=gpt-5.3-codex
export ASTRAEA_DEV_LLM_COMMAND='["codex","exec","--model","{model}","-"]'
```

Start the API directly in this shell (for example, `bun --filter @astraea/api dev`). The `{model}` placeholder is replaced only within argv elements; Astraea sends each prompt on standard input, never invokes a shell, and reads standard output as the answer. The command must be a JSON array, so another CLI can be used when it implements the same stdin/stdout contract.

Codex's ChatGPT subscription OAuth remains in the local CLI credential store and is never read, copied, or persisted by Astraea. This mode is development-only: it is rejected when `NODE_ENV=production` unless `ASTRAEA_ALLOW_DEV_LLM_IN_PRODUCTION=true` is explicitly set. Do not enable it in Docker or production deployments; use normal provider API credentials there. Optional limits are `ASTRAEA_DEV_LLM_TIMEOUT_SECONDS` (default 60, maximum 300) and `ASTRAEA_DEV_LLM_MAX_OUTPUT_BYTES` (default and maximum 65536).

### Sending traces from your agent

Set these four env vars on your instrumented agent:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:3000"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $(echo -n 'astraea:YOUR_PASSWORD' | base64)"
export OTEL_SERVICE_NAME="my-agent"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production"
```

See [`docs/03-otel-ingest.md`](docs/03-otel-ingest.md) for Python and Node.js examples.

### `make codegen`

Regenerates the typed TypeScript and Python clients from `openapi.yaml` (which is itself regenerated by `make openapi-snapshot`). Idempotent: running twice produces no diff.

### `make seed-traces`

Bulk-loads OTLP traces into a running stack for query-perf testing or UI demos. Defaults to **100k mixed-genai+openinference traces spread across the last 30 days** (~2.3k traces/sec on the local dev stack). Override via env or flags:

```sh
make seed-traces                                 # 100k mixed, last 30 days
make seed-traces SEED_COUNT=1000                 # quick smoke
SEED_CONVENTION=genai make seed-traces           # only OTel GenAI attrs
SEED_CONVENTION=openinference make seed-traces   # only Arize Phoenix attrs
make seed-traces-reset                           # wipe + re-seed (TRUNCATE traces + observations first)
```

Or invoke the script directly for finer control:

```sh
infra/scripts/seed-traces.sh --count 5000 --convention mixed --batch-size 100 --concurrency 8 --days 30
infra/scripts/seed-traces.sh --help
```

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

**`make dev-backend` fails with `unexpected EOF while looking for matching '`** — your `infra/.env` has Windows CRLF line endings. Pull the latest commit (which moved env-sourcing into `infra/scripts/with-local-env.sh` that self-normalizes) and re-run. Or run `make normalize` to strip CRLF in place.
