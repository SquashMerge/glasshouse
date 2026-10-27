# Glasshouse — developer and coding-agent setup

**Last refreshed:** 2026-10-04

This is the concise operational guide for a clean Glasshouse checkout. Treat the checked-in files as the source of truth when this guide and the implementation diverge:

1. `AGENTS.md` for repository rules and coding-agent behavior.
2. `infra/.env.example` for supported runtime configuration.
3. `Makefile`, `infra/compose*.yaml`, and package scripts for executable commands.
4. `README.md` for the broader product and local-development reference.

Do not put real credentials, local paths, auth-state locations, copied diagnostic output, or private infrastructure details in this file.

## Runtime architecture

- Bun workspace: Hono API in `apps/api` and React/Vite web app in `apps/web`.
- PostgreSQL stores transactional data; ClickHouse stores trace/OLAP data; Valkey is the Redis-compatible queue/cache service.
- Production runs the PostgreSQL and ClickHouse migration runners concurrently before every API start; the API starts only after both succeed. PostgreSQL tracks applied migrations, while ClickHouse records checksum-verified changesets so later starts skip already-applied SQL. They remain separate schema systems and local host development invokes their runners explicitly.
- Python is isolated to compute-heavy integrations such as the GEPA worker; keep credentials at the worker/deployment boundary.
- Production uses `infra/compose.production.yaml` and `docs/self-hosted-production.md`, not the local `make dev` Compose path. It binds API/web to loopback, keeps data services private, validates production secrets/HTTPS/`NODE_ENV`, and rejects the development GEPA CLI mode.

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
- Docker container log rotation (`DOCKER_LOG_DRIVER`, `DOCKER_LOG_MAX_SIZE`, and `DOCKER_LOG_MAX_FILE`) defaults to the `local` driver, 10 MiB files, and 3 files per service in both the full-stack and dependency-only Compose files. The selected driver must accept the interpolated size/count options; external drivers own retention and should be exported before local rotation where applicable. See the README for the deployment-specific override contract.
- PostgreSQL, ClickHouse, and Valkey credentials/ports plus their local URLs.
- Basic-auth credentials and the bootstrap owner. Multi-organization Basic Auth is supported by `GLASSHOUSE_BASIC_AUTH_CREDENTIALS`; usernames normalize as printable-ASCII `basic:v1` subjects and cannot collide after normalization. Bootstrap provisions a durable identity for every configured credential, while only `GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME` receives bootstrap membership grants. Bootstrap refuses a configured owner whose canonical subject is quarantined for a legacy collision or cross-organization assignment; resolve the legacy authorization data rather than granting recovery authority. Keep the JSON and all passwords in `infra/.env` or deployment secrets.
- `GLASSHOUSE_AUTH_BOOTSTRAP_MODE` defaults to `basic`, retaining that automatic bootstrap. Set `local` before first migration on intentionally local-first installs to skip it without removing existing Basic actors/grants. Migration 0098 adds local credentials, permanently closed first-Admin setup controls, and 7-day first-password/invitation enrollments. `GLASSHOUSE_DEFAULT_ORGANIZATION_ID` selects the pre-existing bootstrap Organization. Explicit `bun run --cwd apps/api auth:provision-bootstrap` reads a 32-byte base64url token from `GLASSHOUSE_LOCAL_BOOTSTRAP_TOKEN_FILE`, storing only its digest with 24-hour expiry; startup never provisions/refreshes it. Existing/first Admins close setup. See `docs/local-credentials-runbook.md` and `docs/local-sessions-runbook.md`; browser setup/account UX follows in #190.
- Evaluation workers use automatically provisioned, organization-scoped `internal:evaluation-worker:v1` actors. They never use Basic credentials or legacy memberships; the internal trace path only locks an active project for that organization. Public OTLP and seed traffic continue to use ordinary Basic-auth authorization.
- Development and CI can set `GLASSHOUSE_EVAL_LLM_PROVIDER=fake` with `OPENAI_MODEL=deterministic` and `EVALUATION_ALLOWED_MODELS=fake/deterministic` for provider-independent browser coverage. The fake provider returns bounded deterministic output at zero cost and is rejected when `NODE_ENV=production`.
- Optional trace redaction and API body-size limits.
- OTLP retained text is redacted before fixed UTF-8 retention ceilings (8 KiB per input/output field and 16 KiB metadata). Legacy oversized rows are read-time bounded without historical rewrites. List and detail materialization is capped at 256 KiB; a trace-detail SSE snapshot is capped by the smaller of that response ceiling and `SSE_MAX_PENDING_BYTES`. Callers must honor truncation metadata and use a returned Project-scoped `next_cursor` (also trace-scoped for detail/SSE) rather than treating a bounded page as a complete trace. Trace/Observation list `limit` defaults to 50 and clamps at 200; legacy `offset` pagination remains supported, but new callers should use cursors.
- GEPA provider allowlisting and credentials. The UI sends model identifiers only; provider credentials never belong in job records, prompts, logs, or browser state.

## Running Glasshouse

### Full Docker stack

```sh
make dev
# Builds and starts PostgreSQL, ClickHouse, Valkey, API, and web, waiting for health checks.

make ps
# Confirms the Compose services are running and healthy.

make down
# Stops the full local stack when finished.
```

The dashboard is available at `http://localhost:5173`; API documentation is at `http://localhost:3000/reference` unless ports were changed in `infra/.env`. PostgreSQL, ClickHouse, and Valkey are published on loopback only, so their development ports are not reachable from other hosts by default.

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

`make dev-backend` runs both schema systems concurrently before it starts the API watcher. They run once for each explicit `make dev-backend` invocation, not for every watch-triggered source reload. Run either command below only when intentionally applying a single schema system:

```sh
bash infra/scripts/with-local-env.sh bash -c 'cd apps/api && bun run db:migrate'
# Applies idempotent PostgreSQL migrations and required bootstrap data to the localhost data service.

bash infra/scripts/with-local-env.sh bash -c 'cd apps/api && bun run ch:migrate'
# Runs the ordered, idempotent ClickHouse migration runner against the localhost data service.
```

## Schema and seed-data work

- PostgreSQL changes and required bootstrap data use a new monotonically numbered file in `infra/db/migrations/` with an unused numeric prefix; never edit an applied migration. `bun run db:migrate` first runs `infra/scripts/verify-pg-migration-filenames.ts`, and `bun run test:pg-migration-filenames` runs the same guard in CI/local tests. The historic `0019`, `0023`, and `0024` prefix collisions are explicitly allowlisted so databases that recorded the older ordering can continue to upgrade; no new duplicate prefix is permitted. Migration `0055_dataset_identity_lifecycle_drafts.sql` quarantines and wraps legacy scalar or array `dataset_items.input` values after creating its required dataset identity index and before creating object-constrained snapshots, so fresh and upgrading databases follow the same ordered schema transition. Migration `0064_legacy_dataset_item_project_scope.sql` derives legacy item ownership only from its Dataset, quarantines cross-Project experiment item links, removes their executable rows, and cancels affected active experiments before adding composite scope constraints.
- Migration `0073_dataset_collaborative_lifecycle_governance.sql` adds Dataset lifecycle revisions, retention-hold storage, and a database hard-delete guard. Run `make test-db-migrations` for this migration; its upgrade fixture verifies that an active hold prevents hard deletion.
- Migrations `0075_evaluation_identity_definition_versions.sql` through `0079_evaluation_slug_identity_guard.sql` add project-scoped Evaluation identities, drafts, immutable Definition Versions and audit events, truthful legacy links, the typed Definition contract, lifecycle archive/tombstone state, tombstone immutability outside authorized Project deletion, and canonical slug guards. The 0079 upgrade migrates UUID-shaped or route-reserved legacy Evaluation slugs to deterministic canonical values while retaining UUID detail access. Run `make test-db-migrations` after changes affecting these migrations: the Docker-backed harness runs the normal migration command twice, exercises the 0075-to-0076 and 0078 upgrade fixtures, and verifies the lifecycle and identity guards.
- Migration `0080_evaluation_run_admission.sql` adds project- and organization-scoped Evaluation Run admissions, immutable resolved target/evaluator/sample snapshots, sampled per-item task links, idempotency replay constraints, and status synchronization to linked Experiments. Migration `0081_fix_unadmitted_experiment_deletion.sql` keeps admitted Experiments immutable while allowing ordinary deletion of unadmitted compatibility Experiments. Migration `0082_fail_closed_admitted_experiment_deletion.sql` keeps that deletion escape authorized only when the project-deletion context explicitly matches, including when the authorization helper returns NULL. The new Evaluation Run route admits only typed Definition Versions; Experiment and benchmark start requests that omit admission fields are rejected with an explicit compatibility error, while historical records remain read-only legacy compatibility data. Run `make test-db-migrations` after changes to these migrations; verify that migration 0080 is applied after 0079 and that task claims use `evaluation_run_items` rather than mutable Dataset rows.
- Migration `0083_durable_evaluation_run_execution.sql` adds the durable Evaluation Run task ledger fields, bounded attempts and backoff, lease heartbeats, safe result evidence, replayable content-free lifecycle events, transition guards, and run-linked task seeding. Migration `0085_evaluation_task_cost_reservations.sql` adds persisted pre-dispatch budget reservations; the experiment lock serializes reservations across workers and expired reserved leases fail closed as unknown dispatches. Migration `0086_evaluation_run_terminal_reason_order.sql` preserves explicit terminal reasons when compatibility Experiment status synchronization fires. Migration `0088_evaluation_gate_approvals.sql` adds Admin-approved, project-scoped Evaluation Gate approvals and invocations pinned to immutable Definition and Dataset Version hashes, append-only content-safe audit history, and terminal machine-readable gate outcomes. `POST /v1/evaluations/{slug}/runs` now launches bounded durable workers; `GET`, `POST .../cancel`, `POST .../retry`, and replayable `.../events` endpoints expose the run lifecycle. SSE clients resume with `Last-Event-ID`. `EVALUATION_RUN_CONCURRENCY` defaults to 4 and is bounded to 1-32. Run `make test-db-migrations` after changes to verify the 0083-0088 schema and fixture assertions.
- Evaluation provider responses must report an explicit non-negative `cost_usd` for a successful item. OpenAI Chat Completions supplies token usage, not monetary cost, so Glasshouse does not estimate unknown pricing; with a configured cost limit, an item without billable cost fails closed, terminalizes the run, and prevents subsequent item dispatch. Run limits are enforced against persisted provider-reported costs with an atomic pre-dispatch reservation. Dispatch and trace effect keys are attempt-specific; only a deterministic provider validation failure that is safe to retry gets a new dispatch key. HTTP 429/5xx responses, transport failures, and undecodable responses remain uncertain terminal evidence. OpenAI receives pinned model, temperature, max_tokens, and messages. The development-only `codex_cli` adapter deliberately keeps its stdin contract and does not emulate OpenAI temperature/max_tokens fields.
- Migrations `0090_agent_introspection_reports.sql` and `0091_agent_introspection_run_item_scope.sql` add one immutable, strict `client_reported` references-only report for an existing Run task invocation and enforce that its Run item belongs to that Run. Collision remediation is ledgered in 0091, not run as a destructive preflight; node-pg-migrate applies pending migrations with `singleTransaction: true`, so a later failure rolls back its collision quarantine and report cleanup. Additive migrations `0092_agent_introspection_scope_pair_integrity.sql` and `0093_evaluation_run_item_dataset_version_item_scope.sql` remediate legacy half-scoped or Dataset-version-item-misassociated task/result pairs only when proven; `0094_experiment_run_lineage_and_report_actor_scope.sql` also binds each task/result Run to its Experiment and report actor to its organization with composite foreign keys. All other Run links are quarantined and removed while result content is retained rather than guessed. Project deletion clears both quarantine tables. They add no Agent runtime, Registry, framework dependency, configuration, or SSE/OTLP surface. Run `make test-db-migrations` after changes to verify populated upgrades and fixture assertions; `openapi.yaml` is tracked, and `bun run openapi:check` rejects a missing or drifted canonical snapshot before code generation.
- Migrations `0095_evaluation_execution_bounds.sql` and `0096_rename_evaluation_requested_sample_size_bound.sql` snapshot the safe operator envelope at Evaluation Run admission: `EVALUATION_ALLOWED_MODELS` (default `openai/gpt-4o-mini`), active runs per Project/actor (defaults 4/2, maximum 32 each), `EVALUATION_MAX_REQUESTED_SAMPLE_SIZE_PER_RUN` for the requested Definition sample-size cap, and provider-call cap (defaults 100/100, maximum 10,000 each). The 0096 forward-only backfill rewrites existing immutable snapshots before replacing the storage check, so historical Runs expose the same truthful name. Bounds are immutable in `evaluation_run_inputs`; active capacity is durable, seeded for upgrade-time pending/running Runs, reconciled before recovery, and released exactly once at a terminal Run status. Provider calls are atomically charged against the persisted snapshot before dispatch, including retry/recovery; `provider_calls_used` is a pre-dispatch charge, not confirmation of provider success. `make dev` passes `infra/.env` to Compose for interpolation, while `infra/compose.yaml` explicitly forwards the Evaluation envelope to the API; the devcontainer `env_file` separately injects it into workspace. New Experiment and benchmark compatibility starts already route through the same admission path, so they cannot select a provider/model or bypass the bounds. Run `make test-db-migrations` after changes; its 0095/0096 assertion proves the storage constraints, backfill, charge cap, snapshot immutability, and terminal capacity release.
- Migration `0041_admin_user_read_only_authorization.sql` adds the additive Admin/User/Read-only policy mapping. It starts organizations in Basic Auth compatibility mode and provisions that mode for future organizations. Before a deliberate strict cutover, run `SELECT * FROM authorization_role_migration_readiness('<organization-uuid>')`, resolve every quarantine record against the underlying legacy data, then run `SELECT enable_admin_user_read_only_enforcement('<organization-uuid>')`. The action is idempotent and fails closed without a valid Admin or with unresolved quarantine rows.
- Migration `0042_experiment_requester_authorization.sql` records the durable Basic Auth actor that initiated every new experiment. It safely cancels pre-existing unbound pending/running experiments and their tasks. Evaluation claim, provider invocation, result persistence, tracing, completion, and restart recovery all recheck that requester still has execute access; revoking or demoting that requester prevents later work from running.
- Migrations `0043_authorization_revocation_fence.sql` through `0046_authorization_lock_order_and_effect_keys.sql` make membership revocation, demotion, and archival invalidate durable execution admissions, effect claims, and affected work. The single PostgreSQL authorization order is actor organization membership, actor Project membership, then Project rows. PostgreSQL acquires a revoked membership row before its `BEFORE ROW` trigger locks Project rows, so every authorization, admission, effect, SSE, organization-management, and default-project transaction follows membership-to-Project order. Lock-phase `40P01` and `40001` failures retry only before a callback runs, so no provider, effect, or SSE output is repeated. Provider dispatch and every trace, metric, result, or lifecycle-event write commit a bounded effect claim after validation. Claims use caller-stable effect keys and only a newly created claim may invoke an external provider or ClickHouse writer; existing keys represent a committed-or-ambiguous prior attempt. If revocation wins first no call is made; if the claim wins first revocation aborts and cancels local work. PostgreSQL cannot atomically undo a remote provider or ClickHouse effect whose claim won first. `EXECUTION_ADMISSION_TIMEOUT_MS` defaults to 30000 ms (1000-300000) and `EXECUTION_ADMISSION_POLL_MS` defaults to 250 ms (50-5000). Every authenticated optimization, trace, observation, and evaluation SSE comment, snapshot, data, heartbeat, status, and error frame is fenced independently through write settlement. Detail-trace subscriptions also cap buffered live observations by `SSE_MAX_PENDING_FRAMES` (32, range 1-256) and encoded `SSE_MAX_PENDING_BYTES` (65536, range 1024-1048576) before their snapshot completes; their request abort, snapshot deadline, and buffer overflow abort the ClickHouse snapshot HTTP query and remove subscriptions/listeners. `SSE_FRAME_WRITE_TIMEOUT_MS` defaults to 5000 ms (100-60000) and also bounds detail snapshot acquisition. Timeout, cancellation, or overflow closes or declines the stream and drops queued frames. Run `make test-db-migrations` with Docker; it now makes the two-connection PostgreSQL race suite mandatory.
- Migration `0048_project_audit_lock_order.sql` supersedes the earlier three-step lock-order description: authorization and retained-audit mutations take organization membership rows, Project membership rows, Project rows, then Project audit UUID advisory locks. PostgreSQL has already locked a revoked membership row before its `BEFORE ROW` trigger; the trigger locks affected Projects and audit UUIDs before admission cancellation. Lock-phase retries run before mutations, so they cannot duplicate an audit or effect.
- Migration `0103_organization_role_project_access.sql` makes durable Organization roles the only effective Project authorization source: each Organization member accesses every Project in that Organization according to their role. `/v1/admin/*` and `/access` are Admin-only management surfaces; Access returns human usernames and omits the internal evaluation worker identity. The existing configured `GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME` credential is the only break-glass authority: its own organization only, exact `RESTORE ADMIN` confirmation, no active Admin prerequisite, append-only content-free audit, and durable 15-minute cooldown (including denied attempts). It creates no token/password and must be rotated only in deployment-secret configuration. The database blocks final-Admin demotion, removal, and identity unlinking. Run `make test-db-migrations` after changes to this migration; it needs Docker.
- Migration `0074_durable_project_restore_guard.sql` makes archived-Project restoration use the durable `project_manage` policy. A provisioned Admin can restore without a legacy membership projection; Projects with no durably authorized manager remain blocked. Its upgrade fixture runs through `make test-db-migrations` and requires Docker.
- ClickHouse changes live under `infra/db/clickhouse/` and are applied with `make ch-schema`.
- Migration `0105_governance_policy_defaults.sql` backfills one audited, automatically approved 30/90/90, no-redaction governance baseline for every Project without an approved policy and installs the Project-insert trigger for future Projects. It preserves approved custom policies and draft history, and never starts retention; run `make test-db-migrations` after changing this bootstrap contract.
- Run the migration fixture coverage when changing PostgreSQL migrations.
- Migration `0099_usable_local_admin_guard.sql` makes final-Admin role removal and break-glass recovery share `organization_actor_is_usable_admin`: local Admins require enabled credentials with a password hash; legacy/non-local identities retain their existing behavior. Pending/revoked-passwordless and disabled local Admin records/roles remain intact without blocking operator recovery. Setup remains permanently closed.
- Migration `0100_usable_local_admin_identity_unlink_guard.sql` applies the same credential-aware usable-Admin semantics to the identity-unlink guard while excluding the removed identity and retaining the organization advisory fence. Pending, revoked, expired-passwordless, and disabled local Admins cannot replace an unlinked Basic Admin; an enrolled enabled local Admin can. The 0100 SQL assertions also reject an enabled password-bearing non-Admin and verify that unlinking preserves role/account records.
- Local credential verification: run `bun test --cwd apps/api tests/integration/local-credentials.test.ts` with a real container-network `DATABASE_URL` and database-creation privileges. It creates/drops isolated fresh/0097/0098/0099-upgrade databases, tests usable-Admin role and identity-unlink guards and the real recovery handler, and proves concurrent setup with observed PostgreSQL waiters. `make test-db-migrations` also invokes it and the 0100 SQL assertions; that full harness needs Docker inside the execution environment. If unavailable, report that gate unverified and use the focused suite on devcontainer PostgreSQL, never host-service fallback. `bun run --cwd apps/api auth:calibrate-passwords` measures the versioned Bun Argon2id policy without printing secrets/hashes.
- Migration `0101_local_sessions.sql` adds fixed eight-hour revocable local sessions, one-way digests, credential-version revocation, bounded login admission and content-free audits. Configure `GLASSHOUSE_PUBLIC_ORIGIN` to the exact HTTPS browser origin behind a proxy; `NODE_ENV=production` makes the HttpOnly `/v1`, SameSite Strict cookie Secure. Cookie mutations require `x-glasshouse-csrf` from `/v1/auth/session`; a presented cookie always wins over Basic. Only method-exact health, setup, login and invitation acceptance are public; root documentation now requires authentication. Browser sign-in now uses a separate local account, in-memory CSRF, cookie restoration and server-side logout; setup/account UX follows in #190. See `docs/local-sessions-runbook.md` for the full route and worker/recovery inventory. Local credential fences precede authorization rows; request fences use a separate bounded connection pool, SSE rechecks every frame, and background jobs retain current durable Actor authority rather than browser-session claims.
- Session verification: `bash infra/scripts/with-local-env.sh bun test --cwd apps/api tests/integration/local-sessions.test.ts` uses private service URLs and isolated fresh/populated-0100 databases. It observes PostgreSQL auth-vs-disable/revoke waiters and tests storage guards, cookie/CSRF, workspace boot, OTLP, SSE and every protected OpenAPI operation. The Docker migration harness also runs it. Regenerate `openapi.yaml` with `bun run openapi:snapshot` and check it after typed route/security changes.
- Migration `0102_local_actor_execution_scope.sql` retains the Experiment/Evaluation Run requester tenant triggers while admitting eligible local human actors; internal evaluation worker identities remain excluded as human requesters. The session suite exercises real local Run admission, tasks and recovery before/after disablement.
- #190 supersedes the earlier pending-browser notes: `/setup`, `/login`, `/enroll` and Admin controls on `/access` use cookie sessions, remove legacy Basic credentials from both Web Storage types, and retain CSRF only in memory. Username-only management contracts reuse credentials/enrollments/RBAC; no new migration or email/provider/domain configuration is needed. Reset/disable/role mutations fence credential/session state before roles and the existing final-Admin advisory lock. Run `bun test --cwd apps/api tests/integration/local-accounts.test.ts` on isolated PostgreSQL; the historical migration harness includes it. Hosted CI adds a local-first browser journey and setup closure after restart. Auth traces/screenshots/video/HAR/storage-state are disabled. Regenerate ignored TS/Python clients with `bun run codegen`; `openapi.yaml` remains tracked. See `docs/local-account-management.md` for handoff, HTTPS and recovery.
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
GLASSHOUSE_DEV_LLM_COMMAND='["codex","exec","--model","{model}","-"]'
GEPA_PYTHON="$PWD/worker/.venv/bin/python"
```

Create that local worker environment before starting the API:

```sh
uv venv worker/.venv
uv pip install --python worker/.venv/bin/python -r worker/requirements.txt
# Installs the GEPA worker dependency into the interpreter used by the local API.
```

`make dev-backend` sources `infra/.env` from the repository root, so `$PWD` expands to the checkout path and gives the worker a canonical interpreter path. Use the exact allowlisted model value in both GEPA model-role fields. Glasshouse replaces `{model}` only inside argv elements, sends the prompt on standard input, and never reads or persists Codex OAuth credentials. The API supplies a durable provider-dispatch key to each worker; the CLI receives a per-call sequence key only through `GLASSHOUSE_PROVIDER_DISPATCH_KEY`. The CLI adapter and development LLM override are rejected under `NODE_ENV=production`.

For autonomous coding or review through Feature Factory, use the configured OpenCode profile.

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

E2E browser helpers require `E2E_LOCAL_USERNAME` / `E2E_LOCAL_PASSWORD` for a separately provisioned local account; `UI_USERNAME` / `UI_PASSWORD` remain direct API Basic fixtures in the main E2E job. Hosted CI starts in local-bootstrap mode, uses a masked random operator token and independent random test password through the real operator/bootstrap setup path, then explicitly restores Basic bootstrap access. The separate `local-onboarding` job retains local-only bootstrap, provisions a restricted setup file, and uses an independently generated/masked local `UI_PASSWORD` for its browser journey before verifying setup closure after restart. Both jobs use one browser worker, disable failure-page snapshots and auth recordings, and avoid secret-bearing input call logs. Set the exact browser origin (`http://localhost:5173` in CI). Never import the Basic password into local credentials or record E2E auth requests/cookies in traces, screenshots or video. `docs/local-sessions-runbook.md` describes the setup/replay and dual-auth regression checks.

The current Bun-only Alpine devcontainer exposes a `node` shim rather than a native Node runtime. Vitest/jsdom requires native Node `22.12+`; invoking that shim can fail before collecting browser unit tests with an EventTarget initialization error. Supply native Node inside the devcontainer for those checks and report them blocked until available; never fall back to host execution. The Docker-backed migration harness likewise needs nested Docker, while focused PostgreSQL session/credential tests use the isolated service network directly.

## Documentation maintenance for every PR

Documentation currency is part of the implementation contract:

- Assess `.opencode/SETUP-NOTES.md` in every PR. Update it whenever a change affects developer prerequisites, configuration/env vars, service topology, startup/migrations, model/provider workflow, generated clients, test commands, or known operational constraints.
- Update `AGENTS.md` in the same PR only when the change creates or changes a durable instruction a coding agent needs to make correct, safe changes. Keep it concise and repository-wide; do not copy feature-specific implementation notes into it.
- Update the glossary when terminology changes, and update public README/docs when their documented user-facing behavior changes.
- In the PR description, state which documentation was updated or why no documentation change was needed. Do not merge an implementation PR with stale setup guidance.
