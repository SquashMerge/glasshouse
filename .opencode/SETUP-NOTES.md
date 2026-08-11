# Astraea — developer and coding-agent setup

**Last refreshed:** 2026-08-07

This is the concise operational guide for a clean Astraea checkout. Treat the checked-in files as the source of truth when this guide and the implementation diverge:

1. `AGENTS.md` for repository rules and coding-agent behavior.
2. `infra/.env.example` for supported runtime configuration.
3. `Makefile`, `infra/compose*.yaml`, and package scripts for executable commands.
4. `README.md` for the broader product and local-development reference.

Do not put real credentials, local paths, auth-state locations, copied diagnostic output, or private infrastructure details in this file.

## Runtime architecture

- Bun workspace: Hono API in `apps/api` and React/Vite web app in `apps/web`.
- PostgreSQL stores transactional data; ClickHouse stores trace/OLAP data; Valkey is the Redis-compatible queue/cache service.
- Production runs the ordered PostgreSQL and ClickHouse migration runners before the API starts. They remain separate schema systems and local host development invokes their runners explicitly.
- Python is isolated to compute-heavy integrations such as the GEPA worker; keep credentials at the worker/deployment boundary.

## Prerequisites

- Docker with Compose v2.13+.
- GNU Make (every documented runtime, migration, and verification target is a Makefile target).
- Bun `1.3.14+`; Node `22.12+` is also pinned for supporting tooling.
- `uv` when running Python code generation or worker tooling.
- The repository's `.tool-versions` can be installed through `make setup-tools` when using asdf.
- A locally authenticated OpenAI Codex CLI only when testing the development-only GEPA CLI adapter.

```sh
make setup-tools
# Installs the repository's asdf-pinned development tools.

bun install --frozen-lockfile
# Installs exactly the dependency graph committed in bun.lock.
```

## Bootstrap configuration

Copy the template before starting any Compose target. `make doctor` checks the required environment values and rejects placeholder values, so replace every required `CHANGE_ME` value rather than committing an edited file. `make dev` remains the final Compose-level readiness check.

```sh
cp infra/.env.example infra/.env
# Creates the gitignored local runtime configuration from the reviewed template.

make doctor
# Checks the local tools and required configuration before the Compose-level startup check.
```

The local template configures:

- API and web ports (`API_PORT`, `WEB_PORT`) and `LOG_LEVEL`.
- PostgreSQL, ClickHouse, and Valkey credentials/ports plus their local URLs.
- Basic-auth credentials and the bootstrap owner. Multi-organization Basic Auth is supported by `ASTRAEA_BASIC_AUTH_CREDENTIALS`; usernames normalize as printable-ASCII `basic:v1` subjects and cannot collide after normalization. Bootstrap provisions a durable identity for every configured credential, while only `ASTRAEA_BOOTSTRAP_OWNER_USERNAME` receives bootstrap membership grants. Bootstrap refuses a configured owner whose canonical subject is quarantined for a legacy collision or cross-organization assignment; resolve the legacy authorization data rather than granting recovery authority. Keep the JSON and all passwords in `infra/.env` or deployment secrets.
- Evaluation workers use automatically provisioned, organization-scoped `internal:evaluation-worker:v1` actors. They never use Basic credentials or legacy memberships; the internal trace path only locks an active project for that organization. Public OTLP and seed traffic continue to use ordinary Basic-auth authorization.
- Optional trace redaction and API body-size limits.
- GEPA provider allowlisting and credentials. The UI sends model identifiers only; provider credentials never belong in job records, prompts, logs, or browser state.

## Running Astraea

### Full Docker stack

```sh
make dev
# Builds and starts PostgreSQL, ClickHouse, Valkey, API, and web, waiting for health checks.

make ps
# Confirms the Compose services are running and healthy.

make down
# Stops the full local stack when finished.
```

The dashboard is available at `http://localhost:5173`; API documentation is at `http://localhost:3000/reference` unless ports were changed in `infra/.env`.

### Fast local API and frontend iteration

Use this mode for Bun/Vite hot reload. Do not run `make dev` at the same time because it uses the same ports.

```sh
make deps-up
# Starts only PostgreSQL, ClickHouse, and Valkey in Docker.

make dev-backend
# Runs the Hono API on the host using infra/.env and the Docker data services.

make dev-frontend
# Runs the Vite app on the host and proxies API routes to the local backend.
```

Before starting a local API against fresh `deps-up` data services, apply both schema systems from the host process. `make dev-backend` does not run either migration runner:

```sh
bash infra/scripts/with-local-env.sh bash -c 'cd apps/api && bun run db:migrate'
# Applies idempotent PostgreSQL migrations and required bootstrap data to the localhost data service.

bash infra/scripts/with-local-env.sh bash -c 'cd apps/api && bun run ch:migrate'
# Runs the ordered, idempotent ClickHouse migration runner against the localhost data service.
```

## Schema and seed-data work

- PostgreSQL changes and required bootstrap data use a new monotonically numbered file in `infra/db/migrations/`; never edit an applied migration.
- Migration `0041_admin_user_read_only_authorization.sql` adds the additive Admin/User/Read-only policy mapping. It starts organizations in Basic Auth compatibility mode and provisions that mode for future organizations. Before a deliberate strict cutover, run `SELECT * FROM authorization_role_migration_readiness('<organization-uuid>')`, resolve every quarantine record against the underlying legacy data, then run `SELECT enable_admin_user_read_only_enforcement('<organization-uuid>')`. The action is idempotent and fails closed without a valid Admin or with unresolved quarantine rows.
- Migration `0042_experiment_requester_authorization.sql` records the durable Basic Auth actor that initiated every new experiment. It safely cancels pre-existing unbound pending/running experiments and their tasks. Evaluation claim, provider invocation, result persistence, tracing, completion, and restart recovery all recheck that requester still has execute access; revoking or demoting that requester prevents later work from running.
- Migrations `0043_authorization_revocation_fence.sql`, `0044_execution_admission_cancellation.sql`, and `0045_execution_admission_effect_claims.sql` make membership revocation, demotion, and archival invalidate durable execution admissions, effect claims, and affected work. Authorization paths lock organization membership, Project membership, then the Project row, matching the physical PostgreSQL membership-update order and avoiding an inverse-order deadlock. Provider dispatch and every trace, metric, result, or lifecycle-event write commit a bounded effect claim after validation; its commit is the logical PostgreSQL admission point. If revocation wins first no call is made; if the claim wins first revocation aborts and cancels local work. PostgreSQL cannot atomically undo a remote provider or ClickHouse effect whose claim won first. `EXECUTION_ADMISSION_TIMEOUT_MS` defaults to 30000 ms (1000-300000) and `EXECUTION_ADMISSION_POLL_MS` defaults to 250 ms (50-5000). Every authenticated optimization, trace, observation, and evaluation SSE comment, snapshot, data, heartbeat, status, and error frame is fenced independently through write settlement. `SSE_FRAME_WRITE_TIMEOUT_MS` defaults to 5000 ms (100-60000); active plus queued frames are capped by `SSE_MAX_PENDING_FRAMES` (32, range 1-256) and `SSE_MAX_PENDING_BYTES` (65536, range 1024-1048576). Timeout, cancellation, or overflow closes the stream and drops queued frames. Run `make test-db-migrations` with Docker; it now makes the two-connection PostgreSQL race suite mandatory.
- ClickHouse changes live under `infra/db/clickhouse/` and are applied with `make ch-schema`.
- Run the migration fixture coverage when changing PostgreSQL migrations.
- OTLP seeders resolve the authenticated organization's `default` project unless a target project is explicitly supplied. Keep every seeded request project-scoped.

```sh
make db-migrate
# Applies the production PostgreSQL migration command to the local Compose API image.

make test-db-migrations
# Replays and validates PostgreSQL migrations against the repository's migration fixtures.
```

## GEPA local Codex adapter

`GEPA_WORKER_MODE=cli` is for deliberate local development only. The API and a locally authenticated Codex CLI must run on the same host; do not enable it in Docker or production.

Add the following to the gitignored `infra/.env` after authenticating Codex locally:

```env
GEPA_WORKER_MODE=cli
GEPA_ALLOWED_MODELS=gpt-5.6-terra,gpt-5.6-luna
ASTRAEA_DEV_LLM_COMMAND='["codex","exec","--model","{model}","-"]'
GEPA_PYTHON="$PWD/worker/.venv/bin/python"
```

Create that local worker environment before starting the API:

```sh
uv venv worker/.venv
uv pip install --python worker/.venv/bin/python -r worker/requirements.txt
# Installs the GEPA worker dependency into the interpreter used by the local API.
```

`make dev-backend` sources `infra/.env` from the repository root, so `$PWD` expands to the checkout path and gives the worker a canonical interpreter path. Use the exact allowlisted model value in both GEPA model-role fields. Astraea replaces `{model}` only inside argv elements, sends the prompt on standard input, and never reads or persists Codex OAuth credentials. The CLI adapter is rejected under `NODE_ENV=production` unless a deliberate emergency override is configured.

For autonomous coding or review work, use the locally authenticated OpenAI Codex workflow with GPT-5.6 Terra/Luna. Do not use MiniMax or silently fall back to another provider.

## Verification ladder

Use the narrowest relevant check first, then the broader checks that cover the changed component. `make format` rewrites files; use the check script during verification.

```sh
bun run format:check
# Confirms formatting without changing the working tree.

make lint && make typecheck
# Runs the workspace lint and TypeScript checks.

make test
# Runs the API and web unit-test suites.

make test-api-integration
# Runs API integration tests after deps-up plus PostgreSQL and ClickHouse migrations are ready.

make test-e2e
# Runs Playwright after deps-up, dev-backend, and dev-frontend are running.
```

For Bun changes, begin from a clean worktree and run `bun install --frozen-lockfile` before relying on test results. Report unavailable Docker, provider, or browser checks as unverified rather than assuming they passed.

## Documentation maintenance for every PR

Documentation currency is part of the implementation contract:

- Assess `.opencode/SETUP-NOTES.md` in every PR. Update it whenever a change affects developer prerequisites, configuration/env vars, service topology, startup/migrations, model/provider workflow, generated clients, test commands, or known operational constraints.
- Update `AGENTS.md` in the same PR only when the change creates or changes a durable instruction a coding agent needs to make correct, safe changes. Keep it concise and repository-wide; do not copy feature-specific implementation notes into it.
- Update the glossary when terminology changes, and update public README/docs when their documented user-facing behavior changes.
- In the PR description, state which documentation was updated or why no documentation change was needed. Do not merge an implementation PR with stale setup guidance.
