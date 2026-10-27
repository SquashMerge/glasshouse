# Glasshouse

**Glasshouse by SquashMerge** is a source-available observability and evaluation product for agentic applications. “Glasshouse” is the name of the Licensed Work in the repository-root [Business Source License 1.1](LICENSE); it refers to this software. The shipped foundation provides project-scoped OTLP observability, immutable prompt and Dataset versions, configured-LLM Evaluation Runs with bounded evidence/comparison/release gates, feedback review, and governance. A strict `client_reported` Agent Introspection Report contract is shipped as P4 groundwork; versioned Agent manifests, real-agent execution, Agno/SDK integrations, and Agent Registry workflows remain future work. Drift detection remains planned P5 behavior.

> Glasshouse is designed to make agent behavior visible, inspectable, and testable.

**Local dev stack:** Postgres 16 + ClickHouse 24 + [Valkey 8](https://valkey.io) (open-source Redis fork) + Hono + React dashboard, behind `make dev`.

For the separate self-hosted production path, use [`docs/self-hosted-production.md`](docs/self-hosted-production.md) and `infra/compose.production.yaml`. The other Compose files and `make dev` are development-only.

The Compose files use Glasshouse logical volume keys while keeping the established physical data-volume IDs for PostgreSQL, ClickHouse, and Valkey, so this branding change does not orphan existing stores.

### Container log rotation

Both local Compose modes use Docker's `local` logging driver with conservative per-service defaults of `10m` maximum file size and `3` files: the full stack (`infra/compose.yaml`) and the fast local API/frontend mode (`infra/compose.deps.yaml`, started with `make deps-up`). This bounds active local container logs to approximately 30 MiB per service, excluding driver metadata and filesystem overhead; it is not a retention guarantee. Override `DOCKER_LOG_DRIVER`, `DOCKER_LOG_MAX_SIZE`, and `DOCKER_LOG_MAX_FILE` in the untracked `infra/.env` without editing tracked Compose files. The values are interpolated into every service in both files, so `max-size` and `max-file` must be accepted by the selected driver. The base files support drivers such as `local` and `json-file`; they do not claim arbitrary external-driver option compatibility. For an external driver with different options, use a deployment-specific Compose override that replaces the service logging configuration and follow that driver's retention settings.

External drivers generally send logs elsewhere and may ignore or reject these local rotation options; their backend controls retention and disk usage. Export or forward logs to the operator's logging system before local rotation removes older files. For a one-time full-stack capture, run `docker compose --project-directory . --env-file infra/.env -f infra/compose.yaml logs --no-color > glasshouse-logs.txt` from the repository root; when using `make deps-up`, use `-f infra/compose.deps.yaml` instead. Protect and transfer the resulting file according to your organization’s log-handling policy. This change only configures Docker's logging metadata and does not add credentials, authorization headers, or application payloads to logs.

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

Most evaluation platforms measure a single LLM call. **Future P4/P5 Glasshouse** is designed to measure the whole agent as one versioned unit after the foundation-first Dataset, Evaluation, identity, and authorization work is complete.

## Planned P4/P5 agent-platform vision (not current behavior)

1. **P4: add one carefully selected target integration** — a narrow SDK path or generic HTTP target, with the Agent/Manifest contract already established
2. **P4: capture the manifest** — prompts, models, tools, knowledge, storage, routing rules, guardrails, and dependencies as a versioned artifact
3. **P5: integrate pinned evaluations with automation** — programmatic and dashboard runs first; CI/GitHub integration only after protected Evaluation definitions exist
4. **P5: add evidence-based drift detection** — compare trace evidence to resolved manifests; atomic promotion/rollback remains a later P6 decision

## What makes it different

| | Langfuse | Braintrust | LangSmith | Maxim | Helicone | **Glasshouse roadmap phase** |
|---|---|---|---|---|---|---|
| Narrow real-agent target execution | ⚠ | ⚠ | ✅ | ✅ | ❌ | P4 |
| Agent as typed first-class entity | ❌ | ❌ | ⚠ | ❌ | ❌ | P4 |
| Manifest version binding on eval runs | ❌ | ❌ | ❌ | ❌ | ❌ | P4 |
| Multi-tenant Agent registry | ❌ | ⚠ | ⚠ | ⚠ | ❌ | P4 |
| Drift detection (trace vs manifest) | ❌ | ❌ | ❌ | ❌ | ❌ | P5 |
| Atomic manifest rollback | ❌ | ❌ | ❌ | ❌ | ❌ | P6 |
| Incremental framework integrations | ⚠ | ⚠ | ❌ | ⚠ | ⚠ | P5 |
| Packaging and release polish | ⚠ | ❌ | ❌ | ❌ | ⚠ | P6 |

**The planned roadmap pillars:**
1. **P4:** narrow real-agent execution and manifest version binding
2. **P4:** a multi-tenant Agent Registry with versions and history
3. **P5:** incremental framework integrations and protected CI integration
4. **P5:** drift detection using the resolved manifest as an evidence boundary

Atomic manifest rollback is deferred to P6, after the access, Dataset, Evaluation, Agent, and promotion contracts have proven safe.

## License

Licensed under the [Business Source License 1.1](LICENSE) (SPDX identifier: `BUSL-1.1`). The Licensed Work is Glasshouse, © 2026 SquashMerge. Production-use eligibility and restrictions are governed by the Additional Use Grant; the Change Date and Change License are specified in `LICENSE`. Third-party materials that carry their own license remain under their original terms.

## Quick Start

### Prerequisites

- Docker (with Compose v2.13+ for `depends_on condition: service_healthy`)
- GNU Make (all documented local workflows use `make`)
- Bun 1.3.14+ (replaces both the package manager and the runtime; install from [bun.sh](https://bun.sh))
- Node.js 22.12+ (required by local migration tooling; install from [nodejs.org](https://nodejs.org/))
- uv (for the Python codegen client; install from [docs.astral.sh/uv](https://docs.astral.sh/uv/))

On Apple Silicon (M-series) the ClickHouse image is pinned to `platform: linux/amd64` for compatibility.

#### Option A — automatic install via asdf

If you use [asdf](https://asdf-vm.com/), the repo's `.tool-versions` pins the asdf-managed dev tools at the versions the project was built against:

```
bun 1.3.14
nodejs 22.12.0
```

The Postgres, ClickHouse, and Valkey **servers** run in Docker (Compose brings them up). Their CLI clients (`psql`, `clickhouse-client`, `valkey-cli`) are best installed via your OS package manager — see Option B.

Run once after cloning:

```sh
make setup-tools
```

This installs the asdf plugins for every tool and installs the pinned versions. It first uses asdf's plugin index, with explicit upstream fallbacks for Bun and Node.js when the index is unavailable. Re-run anytime `.tool-versions` changes.

### Dependency supply-chain policy

Bun resolves newly added direct and transitive npm packages only after they have been published for seven days (`bunfig.toml`). New direct dependencies are saved as exact versions. A trusted-base workflow independently checks every npm package version newly added to `bun.lock` against the npm registry without checking out or executing pull-request code, so changing a pull request's own verifier cannot bypass the check. GitHub Free cannot make that workflow a required merge check for this private repository; maintainers must review its result until branch-protection support is available. Do not override this policy or add exclusions without a documented security review.

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

Before the first local startup, create and populate the gitignored environment file, then install the exact committed Bun dependency graph:

```sh
cp infra/.env.example infra/.env
# Replace every CHANGE_ME value in infra/.env with a local development secret.
bun install --frozen-lockfile
```

### `make dev`

Brings up the full stack (Postgres + ClickHouse + Valkey + Hono API + Vite web) with healthchecks and waits for all services to be ready. Every API start validates PostgreSQL migration filenames, then runs the PostgreSQL and ClickHouse migration runners concurrently and starts serving only after both succeed. PostgreSQL waits for the `node-pg-migrate` advisory lock before applying or verifying migrations, while ClickHouse checksum-verifies changesets before skipping ones it has already applied. ClickHouse schema application is serialized with a PostgreSQL advisory lock, so multiple API instances sharing the same PostgreSQL and ClickHouse instances cannot apply one changeset concurrently.

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

The local api connects to Postgres / ClickHouse / Valkey on `localhost` (the ports docker compose maps to the host). `make dev-backend` runs the same concurrent migration step before starting its watcher, so a fresh `deps-up` stack is migrated automatically. Watch-triggered source reloads do not repeat migrations.

The Vite dev server proxies `/v1/*`, `/openapi.json`, `/reference`, and `/health` to `localhost:3000`.

Don't run `make dev` and `make deps-up` at the same time — the ports collide.

### Isolated OpenCode development with Dev Containers

For concurrent AI-assisted development, Glasshouse provides a Compose-based devcontainer at `.devcontainer/`. It runs PostgreSQL, ClickHouse, and Valkey on the branch container network without publishing their ports to the host. With the `opencode-devcontainers` plugin configured, start an isolated branch with `/devcontainer <branch-name>` and use `make devcontainer-db-migrate` / `make devcontainer-ch-schema` for migrations. See [`.devcontainer/README.md`](.devcontainer/README.md) for the complete workflow and required `infra/.env` setup.

### URLs after `make dev` (or local workflow)

| URL | Purpose |
|---|---|
| http://localhost:5173/setup | First Admin setup (operator secret, only while available) |
| http://localhost:5173/login | Local username/password sign-in (HttpOnly cookie session) |
| http://localhost:5173/enroll | First password or re-enrollment using an Admin-provided code |
| http://localhost:5173/access | Admin local accounts, existing roles and Project grants |
| http://localhost:5173 | Dashboard (auth-gated; fresh setup or sign-in redirect) |
| http://localhost:5173/observability | Trace and observation lists (auth-gated) |
| http://localhost:5173/observability/traces/:id | Trace detail with observation tree (auth-gated) |
| http://localhost:3000/v1/otel/v1/traces | OTLP HTTP/JSON trace ingest (auth-gated; OTel SDK target) |
| http://localhost:3000/reference | Scalar UI for the typed OpenAPI contract (auth-gated) |
| http://localhost:3000/health | Backend health check (public; no auth) |
| http://localhost:3000/openapi.json | OpenAPI 3.1 JSON document (auth-gated) |

### Local credential foundation

PostgreSQL local credential storage now supports organization-scoped ASCII usernames,
versioned Argon2id hashes, operator-token-guarded first-Admin setup, and Admin-created
first-password/email-invitation records. See the [operator/security runbook](docs/local-credentials-runbook.md)
before selecting `GLASSHOUSE_AUTH_BOOTSTRAP_MODE=local` on a fresh install. The default
`basic` mode preserves existing bootstrap behavior and authorization; no environment
password is imported. The [local session API](docs/local-sessions-runbook.md) now supplies
login/current-session/logout/password-change endpoints, eight-hour revocable HttpOnly
cookies, CSRF protection and the same trusted workspace principal. Configure HTTPS,
`NODE_ENV=production` and the exact `GLASSHOUSE_PUBLIC_ORIGIN` behind a proxy. The setup/account
browser UX is available at `/setup`, `/login`, `/enroll` and `/access`.
Dashboard sign-in uses separately provisioned local credentials; direct API
clients retain Basic Auth compatibility.
See [local account management](docs/local-account-management.md) for manual
enrollment-code handoff, last-Admin protection, HTTPS, recovery and the Basic
operator/API compatibility boundary. Public registration stays disabled.

### GEPA prompt optimization and LLM providers

Prompt optimization uses the isolated Python worker with GEPA `0.1.4` and LiteLLM for normal model-string execution. The dashboard optimizes system prompts only; it does not offer user-prompt optimization. It uses held-out validation, safe GEPA budget callback telemetry, and a strict worker-side metric-call cap; GEPA's best outputs are not retained. The dashboard asks for those two model identifiers when optimization starts; it does not collect or persist API keys. The identifiers are pinned into the job configuration and must be present in `GEPA_ALLOWED_MODELS`.

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

GEPA accepts provider-prefixed model names through its default adapter. Common LiteLLM-compatible providers include OpenAI, Anthropic, Google/Gemini, Azure OpenAI, and AWS Bedrock; the exact model format and required environment variables are provider-specific and must be supported by the installed GEPA/LiteLLM stack. Glasshouse does not currently maintain a provider catalog or model discovery endpoint.

An OpenAI-compatible LiteLLM proxy can be used by pointing the worker's OpenAI adapter at the proxy and supplying the proxy credential as the OpenAI key, for example:

```sh
GEPA_ALLOWED_MODELS=openai/my-proxy-model
OPENAI_API_BASE=https://litellm.example.com/v1
OPENAI_API_KEY=your-proxy-key
```

The current UI exposes model names and the metric-call budget, but not provider credentials, proxy administration, connection testing, or model discovery. Never commit these credentials or store them in prompt/job records. For Docker Compose, place them in the gitignored `infra/.env`; for production, use the deployment secret mechanism. Each job supplies GEPA with a durable provider-dispatch root key; LiteLLM derives unique deterministic task/reflection sequence keys, disables automatic retries, and sends the key through provider idempotency and request-ID facilities. `GEPA_WORKER_MODE=fake` is only for deterministic tests and does not perform LLM calls.

#### Held-out optimization datasets and promotion

Every new optimization pins an embedded `dataset.version: 1` snapshot containing a human-readable scoring rubric/objective, one or more training examples, and one or more held-out validation examples. The raw examples remain server and worker data; job responses expose only the rubric, split counts, and version. Candidates that copy example input material are blocked, including for legacy drafts at read time. Training and validation inputs must be unique and must not materially overlap, contain one another, or use reordered near-identical token sets after Unicode normalization, whitespace collapsing, and lowercasing.

The default adapter executes candidates against expected-answer labels. Training score is a diagnostic only. GEPA ranks candidates by held-out validation score, and automatic publication requires at least two independent held-out examples, a finite candidate validation score that strictly improves on the source prompt's held-out score, and a passed leakage check. A one-example validation score, including `1`, is not evidence of general quality and produces a review-required draft instead of a new prompt version.

Expected answers are evaluation labels, not few-shot prompt material. Glasshouse's reflection adapter does not put them in proposal feedback, and the API blocks normalized full expected-answer token multisets and copied material spans of at least eight normalized tokens and 48 characters, including reordered copies. The check removes control, format, and combining Unicode characters before comparison. Blocked candidates are never stored as drafts or published. Intentional few-shot prompt authoring is a separate reviewed authoring concern and is not created by optimization.

Review-required drafts retain the safe candidate, source/candidate diff, rubric, split counts, baseline and candidate held-out metrics, and leakage outcome. An authenticated actor scoped to the same project may promote a safe draft through `POST /v1/prompt-optimizations/{id}/promote`; promotion fails if the source version is no longer current. This preserves an explicit human review boundary without putting credentials, worker diagnostics, or expected-answer text in lifecycle events.

#### Development-only local CLI authentication

For local development, `GEPA_WORKER_MODE=cli` makes GEPA call a locally authenticated LLM CLI instead of a provider API key. The complete Codex setup is:

1. Install and authenticate Codex on the **same host where the Glasshouse API runs**:

   ```sh
   npm install -g @openai/codex
   codex login
   # If your CLI opens the interactive sign-in flow instead, run `codex`
   # and choose “Sign in with ChatGPT”.
   ```

2. Create the local Python environment used by the GEPA worker:

   ```sh
   uv venv worker/.venv
   uv pip install --python worker/.venv/bin/python --require-hashes -r worker/requirements.lock
   ```

3. Add the development settings to the gitignored `infra/.env` file:

   ```env
   GEPA_WORKER_MODE=cli
   GEPA_ALLOWED_MODELS=gpt-5.6-terra,gpt-5.6-luna
   GLASSHOUSE_DEV_LLM_COMMAND='["codex","exec","--model","{model}","-"]'
   GEPA_PYTHON="$PWD/worker/.venv/bin/python"
   ```

4. Start the local data services and backend:

   ```sh
   make deps-up
   make dev-backend
   ```

5. In the GEPA optimization dialog, enter either `gpt-5.6-terra` or `gpt-5.6-luna` for both the task model and reflection model. The value must be present in `GEPA_ALLOWED_MODELS`.

`make dev-backend` sources `infra/.env` from the repository root, so `$PWD` expands to the checkout path and gives the worker a canonical interpreter path. The `{model}` placeholder is replaced only within argv elements; Glasshouse sends each prompt on standard input, never invokes a shell, and reads standard output as the answer. The command must be a JSON array, so another CLI can be used when it implements the same stdin/stdout contract.

Codex's ChatGPT subscription OAuth remains in the local CLI credential store and is never read, copied, or persisted by Glasshouse. This mode is development-only and is rejected when `NODE_ENV=production`. Do not enable it in Docker or production deployments; use normal provider API credentials there. Optional limits are `GLASSHOUSE_DEV_LLM_TIMEOUT_SECONDS` (default 60, maximum 1800) and `GLASSHOUSE_DEV_LLM_MAX_OUTPUT_BYTES` (default and maximum 65536).

### Sending traces from your agent

Set these five env vars on your instrumented agent. `GLASSHOUSE_PROJECT_ID` must be the UUID of a project that belongs to the authenticated user's organization:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:3000/v1/otel"
export GLASSHOUSE_PROJECT_ID="YOUR_PROJECT_UUID"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $(printf '%s' 'glasshouse:YOUR_PASSWORD' | base64),x-glasshouse-project-id=$GLASSHOUSE_PROJECT_ID"
export OTEL_SERVICE_NAME="my-agent"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production"
```

See [`docs/03-otel-ingest.md`](docs/03-otel-ingest.md) for Python and Node.js examples.

### Client code generation

`openapi.yaml` is the tracked canonical OpenAPI artifact. `bun run codegen` regenerates the typed TypeScript and Python clients from it; `bun run openapi:snapshot` updates only the artifact. `bun run openapi:check` regenerates to a temporary file and rejects missing or stale canonical artifacts. `make codegen` and `make openapi-snapshot` provide equivalent generation targets. These commands are idempotent: running them twice produces no diff.

### `make seed-traces`

Bulk-loads OTLP traces into a running stack for query-perf testing or UI demos. Defaults to **100k mixed-genai+openinference traces spread across the last 30 days** (~2.3k traces/sec on the local dev stack). Override via env or flags:

```sh
make seed-traces                                 # 100k mixed, last 30 days
make seed-traces SEED_COUNT=1000                 # quick smoke
SEED_CONVENTION=genai make seed-traces           # only OTel GenAI attrs
SEED_CONVENTION=openinference make seed-traces   # only Arize Phoenix attrs
make seed-traces-reset                           # wipe + re-seed (TRUNCATE traces + observations first)
SEED_PROJECT_ID=<uuid> make seed-traces          # target a non-default project
```

The seeder resolves the authenticated organization's current `default` project from `GET /v1/projects` and sends its ID on every OTLP request. This is required because traces without an explicit project selector are intentionally unscoped; use `SEED_PROJECT_ID` or `--project-id` to target another project.

Or invoke the script directly for finer control:

```sh
infra/scripts/seed-traces.sh --count 5000 --convention mixed --batch-size 100 --concurrency 8 --days 30
infra/scripts/seed-traces.sh --help
```

### `make smoke`

Runs smoke checks against an already-running stack. It verifies health, the OpenAPI collection roots, the API reference, authentication boundaries, OTLP ingestion/querying, malformed-OTLP rejection, and the Playwright dashboard smoke test.

## Docs

- [`docs/00-explainer.md`](docs/00-explainer.md) — General explainer (the "why" in plain terms)
- [`docs/01-platform-design.md`](docs/01-platform-design.md) — Full technical design (architecture, licensing, integration tiers, deployment, tech stack, REST API)
- [`docs/02-roadmap.md`](docs/02-roadmap.md) — 90-day build plan with Implementation Status
- [`docs/05-unified-dataset-workflow.md`](docs/05-unified-dataset-workflow.md) — implementation contract for versioned datasets, reusable evaluation definitions, and runs
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

**`docker compose ... lstat .../infra/apps: no such file or directory`** — the Compose files are invoked with the repository root as `--project-directory`, so build contexts must be `context: .` and Dockerfiles remain `apps/api/Dockerfile` / `apps/web/Dockerfile`. Pull the latest commit if your checkout still uses `context: ..`.

**`asdf plugin add nodejs` fails** — `make setup-tools` first tries asdf's plugin index and then falls back to the official `https://github.com/asdf-vm/asdf-nodejs.git` repository. If both fail, verify that git can reach GitHub and retry.

**`/health` returns 503 with `valkey: down`** — the valkey container failed healthcheck (probably wrong password or compose started before .env was edited). Run `make doctor` first; if `.env` still has `CHANGE_ME`, edit it and `make dev` again.

**`make dev` warns `The "VALKEY_PASSWORD" variable is not set`** — your `infra/.env` is missing `VALKEY_PASSWORD`. Copy from `infra/.env.example` and edit. The Makefile passes `--env-file infra/.env` to compose; if the file is missing or the var is unset, compose falls back to defaults (warns and uses empty string).

**Local dev (`make dev-backend`) can't connect to Postgres / ClickHouse / Valkey** — `make deps-up` first; it brings the data services up on `localhost:5432 / 8123 / 6379`. If you ran `make dev` (full Docker stack) before, ports may still be bound; run `make down` and then `make deps-up`.

**`/v1/*` requests from the local frontend 404** — make sure `make dev-backend` is running so the Vite proxy has something to forward to. Verify with `curl http://localhost:3000/health`.

**`make dev-backend` fails with `unexpected EOF while looking for matching '`** — your `infra/.env` has Windows CRLF line endings. Pull the latest commit (which moved env-sourcing into `infra/scripts/with-local-env.sh` that self-normalizes) and re-run. Or run `make normalize` to strip CRLF in place.
