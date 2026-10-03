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

## Architecture and runtime

- The repository is a Bun workspace. The user-facing API is TypeScript/Hono, the web app is TypeScript/React/Vite, PostgreSQL stores transactional application data, and ClickHouse stores trace/OLAP data.
- Python is intentionally isolated to compute-heavy integrations such as the GEPA worker. Keep the TypeScript API boundary and Python worker boundary explicit; do not move GEPA/provider credentials into API request bodies, job records, logs, or SSE payloads.
- Every API start runs PostgreSQL and ClickHouse migrations concurrently before serving: `bun run migrate && bun run src/index.ts`. PostgreSQL waits for its migration advisory lock, while ClickHouse takes a PostgreSQL advisory lock, checksum-verifies applied changesets, and skips them on later starts. `make dev-backend` uses the same startup contract; the watch process itself does not re-run migrations on each source reload.
- Docker Compose is invoked with the repository root as its project directory. Preserve root-relative build contexts and ensure every runtime dependency used by startup commands is present in the production image.

## Isolated OpenCode execution

- For any OpenCode build, test, install, migration, or service command, activate this repository's `/devcontainer <branch>` workspace first. It supplies isolated PostgreSQL, ClickHouse, and Valkey services; do not fall back to host Docker or host-local services.
- In a targeted devcontainer, use `make devcontainer-db-migrate` and `make devcontainer-ch-schema` for migrations. `db-migrate` and `ch-schema` are host-Docker targets.
- If the devcontainer cannot start, stop and report the engine/configuration blocker instead of running verification against host services.

## Database migrations and seeded data

- Every PostgreSQL schema or required-bootstrap-data change must include a new, monotonically numbered SQL migration under `infra/db/migrations/` whose numeric prefix is unused. Do not edit an already-applied migration to change live behavior. `bun run test:pg-migration-filenames` rejects new duplicate prefixes; the only exceptions are documented historical collisions.
- Use the existing `node-pg-migrate` path (`apps/api` script `db:migrate`) and keep migrations safe for both fresh and already-populated databases. Prefer `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, and deterministic backfills where appropriate; do not silently overwrite user data.
- When adding a required tenant, project, role, configuration row, or other bootstrap record, decide explicitly how fresh installs and existing installs receive it. For example, adding the `projects` resource required migration `0015_default_project.sql` to insert the `default` project with `ON CONFLICT (slug) DO NOTHING`; application code alone was insufficient for fresh databases.
- Add migration fixture/assert coverage under `infra/scripts/` for constraints, indexes, backfills, and seeded rows. Run `make test-db-migrations` when changing migration behavior, plus the API tests and typecheck.
- Before merging a migration, verify the migration is included in the production image, `make db-migrate` reaches the same `apps/api` script used in deployment, and startup still waits for healthy PostgreSQL before applying it.
- Keep ClickHouse schema changes separate under `infra/db/clickhouse/`; they are not PostgreSQL migrations and are applied by `make ch-schema`.
- Every tenant-bearing table must enforce tenant IDs at storage time: PostgreSQL `organization_id`/`project_id` columns are `NOT NULL` (and reference their tenant parent where applicable); ClickHouse `traces` and `observations` use `CHECK notEmpty(organization_id) AND notEmpty(project_id)`. Never write or retain unscoped trace data: rows with missing tenant provenance are deleted rather than guessed/backfilled to another tenant.
- OTLP seeders and fixtures must be explicitly project-scoped. `infra/scripts/seed_traces.py` resolves the authenticated organization's current `default` project through `GET /v1/projects` unless `SEED_PROJECT_ID`/`--project-id` is provided, then sends `x-astraea-project-id` on every OTLP POST. OTLP ingestion must resolve missing resource provenance to the authenticated organization's default project. If tenant/project or OTLP provenance semantics change, update the seeder, its Python regression test, ClickHouse constraints, OTLP tests, and these rules in the same change.
- Authorization and retained-audit mutations lock organization membership rows, Project membership rows, Project rows, then Project audit-provenance advisory locks. PostgreSQL locks a target membership before its `BEFORE ROW` trigger; preserve that order in triggers, default-project/deletion/retention paths, and lock-phase retries, which must not replay a mutation.
- Archived Project restoration must evaluate durable `project_manage` authority. Never require or fabricate a legacy membership projection to make a durably managed Project restorable.

## Observability and logging

- Use the structured logger in `apps/api/src/lib/logger.ts` for new API logs; do not add ad hoc `console.log` calls. Logs are JSON lines with `time`, `level`, `event`, and safe structured fields.
- `LOG_LEVEL` defaults to `info`; use `debug` temporarily for health checks and low-level coordination events. Normal request completion is `info`, rejected requests are `warn`, and server/worker failures are `error`.
- The request middleware assigns or propagates `x-request-id` and logs method, path, status, and duration. Keep health-check logging at `debug` to avoid flooding normal logs.
- Optimization lifecycle events must remain observable: accepted, claimed, preparing, worker_started, worker_completed, completed, failed, and stop_requested. Include job/project identifiers and timings, but never prompt content, examples, credentials, raw CLI output, or provider payloads.
- Worker stderr must be consumed and logged in bounded form at the API boundary. Keep diagnostics out of job records and SSE responses; the user-facing error should remain sanitized.
- When debugging a background failure, first check the API process log for the `optimization.*` event sequence and the `[gepa-worker]` diagnostic, then inspect the job status/event endpoint. Add or improve instrumentation before guessing at a fix.

## GEPA and local CLI development

- GEPA optimization has two model roles (`task_lm` and `reflection_lm`), explicit examples, and a bounded `max_metric_calls` budget. The UI must collect real evaluation input/answer data; never restore fabricated placeholders.
- Model identifiers must be checked against the exact `GEPA_ALLOWED_MODELS` allowlist. Provider API credentials belong only in the ignored `infra/.env` or deployment secret store.
- `GEPA_WORKER_MODE=cli` is development-only and runs the locally authenticated OpenAI Codex CLI. It requires the API to run on the same host as Codex (`make deps-up` plus `make dev-backend`, not the Dockerized `make dev` path), a local Python environment with `worker/requirements.lock` installed using `--require-hashes`, and `GEPA_PYTHON` pointing to that interpreter.
- Candidate publication must preserve the full message snapshot while deriving canonical `prompt_versions.content` from the optimized target role. Add a system-target regression test whenever this path changes.
- Evaluation Run active-capacity admissions are a PostgreSQL quota ledger: every pending/running Run must hold one active row, terminal/cancelled/revoked Runs must release it once, and admission, retry, and recovery paths must reconcile it at the storage boundary.

## Review and verification

- Review the exact PR head, not a stale local branch or an author's fix comment. Map every blocker to code and regression coverage before declaring it addressed.
- For Bun changes, use a clean checkout/worktree and `bun install --frozen-lockfile` before relying on tests. Run format, lint, typecheck, build, API tests, web tests, and worker tests as applicable; report unavailable Docker/provider checks as unverified rather than passing them by assumption.

## Coding-agent and documentation currency

- For autonomous implementation or review through Feature Factory, use the configured OpenCode profile.
- Treat documentation as part of every PR's implementation contract. Assess `.opencode/SETUP-NOTES.md` for every PR and update it whenever developer prerequisites, environment/configuration, service topology, migrations/startup, model/provider workflow, generated clients, test commands, or operational constraints change.
- Update this `AGENTS.md` in the same PR only for new or changed durable repository-wide instructions a coding agent needs. Keep it concise and do not duplicate feature-specific notes.
- Update the glossary and public documentation when terminology or user-facing behavior changes. The PR description must state which documentation was updated, or why no documentation update was needed.

## UI design and quality bar

- Treat look and feel as a product requirement, not a final polish pass. Every authenticated product page must feel like one coherent Astraea application.
- Use the repository's Tailwind CSS setup as the default styling mechanism: express layout, spacing, typography, responsive behavior, and state styling with composable utility classes. Use the configured semantic theme tokens (for example, `bg-background`, `text-muted-foreground`, and `border-border`) so light/dark themes remain consistent; add a shared token when the design system needs a new semantic role rather than introducing page-local color values.
- Compose conditional Tailwind classes with the shared `cn` helper and keep cross-page visual patterns in shadcn primitives or shared components. Avoid page-scoped CSS and inline styles unless a CSS variable, third-party integration, or behavior Tailwind cannot express makes them necessary.
- Prefer the repository's shadcn UI primitives and shared abstractions (`Button`, `Input`, `Label`, `Card`, `Select`, `Separator`, and existing layout utilities) over raw page-local replicas. If the right primitive is absent, add or extend one deliberately rather than duplicating ad hoc styling.
- Use a deliberate, consistent spacing rhythm. Leave clear separation between page headers, sections, cards, action/filter rows, form fields, and empty/error states; adjacent cards must never appear visually fused or collide at responsive widths.
- Pair each visible form label with its control using the standard label/control pattern and a comfortable vertical gap. Preserve semantic labels, accessible names, keyboard navigation, focus-visible treatment, disabled state, and error/help text relationships.
- Keep shared authenticated pages aligned to the AppShell workspace contract. Do not reintroduce arbitrary page-level outer width caps; intentionally compact forms, dialogs, and popovers may retain local constraints.
- For UI work, review Dashboard, Feedback, Evaluations, and Datasets alongside the changed page when relevant, at representative desktop, laptop/tablet, and mobile widths. Verify visual states and responsive layout with component tests and screenshot/visual evidence where available.

## Comments

Don't add unnecessary comments throughout the codebase. Code should speak for itself. Only comment when the code is complex, easy to misread, hides a non-obvious decision (ordering, race, perf, pinned contract from a brief), or when a brief/issue requires it. Future readers will thank you for fewer lines.
