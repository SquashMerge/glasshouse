# Glossary

Living doc. Keep it short. Update when you add a term, rename something, or notice two names being used for the same thing.

---

## Observability

### Trace
A request through your agent end-to-end. Top-level observability unit. Schema: `apps/api/src/schemas/traces.ts`.

### Observation (preferred over "span")
One unit of work inside a Trace — one row per OTel span. Schema: `apps/api/src/schemas/traces.ts`. Has a `type`:

| `type`       | Meaning                          | Detected by (`apps/api/src/db/gen-ai-attrs.ts:78`)                          |
| ------------ | -------------------------------- | ----------------------------------------------------------------------------- |
| `span`       | Generic OTel span (fallback)     | nothing else matched                                                          |
| `generation` | LLM call                         | `gen_ai.request.model` / `gen_ai.response.model` or `type ∈ {llm,chain,agent}` |
| `tool`       | Tool / retriever / embedding     | `tool.name` or `type ∈ {tool,retriever,embedding,reranker}`                   |
| `event`      | Point-in-time marker             | leftover bucket                                                                |

The four-way split is the Langfuse/LangSmith taxonomy, applied at OTLP ingest. Forward-compat: store one row shape, render off `type` later.

> **Don't say "span" when you mean "observation".** "Span" is reserved for the UI label (the "Spans" tab) and for `observation.type === "span"` specifically.

## Observability UI

- `/observability` — Traces tab + Spans tab. The "Spans" tab is really the observations table (all four types mixed); the label is a legacy holdover.
- `/observability/traces/$id` — Trace detail: tree of observations + detail panel.

## Prompt UI

- `/prompts` — project-scoped prompt list; `/prompts/new` creates the first immutable version; `/prompts/$slug` selects an immutable version; `/prompts/$slug/edit?from=N` starts the next version from version `N`. See `apps/web/src/routes/prompts*.tsx`.
- `POST /v1/prompts/preview` — authenticated, non-persistent Mustache rendering of system and user draft sources with supplied JSON data. See `apps/api/src/routes/prompts.ts`.
- `POST /v1/prompts/{id}/versions/rollback` — authenticated, project-scoped removal of only the latest version; restores the immediately previous version and migrates its labels. See `apps/api/src/routes/prompts.ts`.

## SSE endpoints (all in `apps/api/src/routes/trace-events.ts`)

- `GET /v1/traces/events` → `streamTraceEvents` — broadcasts new traces. Stays open.
- `GET /v1/observations/events` → `streamObservationEvents` — broadcasts new observations. Stays open.
- `GET /v1/traces/{id}/events` → `streamTraceDetailEvents` — single trace: snapshot + filtered live observations + closes after `TRACE_COMPLETE_GRACE_MS` of inactivity.

## Core entities

- **Organization** — top-level authenticated tenancy boundary. Basic-auth credentials resolve to an immutable actor subject and one organization. Organization owners manage organization membership and may create Projects.
- **Project** — organization-owned workspace and data boundary (`project_id` on stored application and observability data). A Project is `active` or non-destructively `archived`; product access requires explicit active Project membership. Its UUID is immutable; its validated slug is unique within its organization.
- **Project membership** — an actor's `manager` or `member` role within one Project. Managers govern membership and lifecycle; members use product data. Organization owners manage the organization membership directory and override Project-manager authorization.
- **Authorization audit event** — append-only, content-free PostgreSQL evidence for workspace bootstrap, membership, and lifecycle actions. `GET /v1/projects/{id}/audit-events` is visible only to organization owners and managers authorized for that Project.
- **Agent** — versioned, typed entity. Multi-tenant, versioned, has a version history.
- **Manifest** — serialized form of an Agent (prompts + tools + routing + guardrails + knowledge + deps as one atomic unit). Pinned to eval runs for bisectable regressions and atomic rollback.
- **Prompt** — immutable collection of up to one system and one user Mustache message, scoped to a Project; its canonical public ID is the Project-local slug, while `slug@version` is display-only. See `apps/api/src/db/prompts.ts`.
- **Prompt provenance** — typed `(id, version, content_hash)` from a generation observation's atomic `astraea.prompt.*` OTLP tuple; `GET /v1/prompt-provenance/{id}` reports whether that scoped tuple is `active`, `deleted`, or `unknown`, without source or render data. All `astraea.prompt.*` input attributes are stripped before metadata storage or events. See `apps/api/src/db/observation-metadata.ts` and `apps/api/src/routes/prompt-provenance.ts`.
- **Prompt tombstone** — immutable `(project_id, slug)` reservation left by a hard deletion; prevents canonical prompt ID reuse. See `infra/db/migrations/0009_prompt_management_canonical.sql`.
- **Prompt deletion audit** — immutable, content-free deletion record: project ID, internal prompt ID, slug, deleting actor, timestamp, and deleted version count. See `infra/db/migrations/0009_prompt_management_canonical.sql`.
- **Prompt optimization job** — a project-scoped GEPA request that pins a source prompt version, target message role, versioned optimization dataset snapshot, worker model configuration, and budget. Its immutable source-message snapshot supports reviewable evidence; `worker_claim_id` with `worker_lease_expires_at` gives one API replica temporary execution ownership and allows recovery after a replica crash. `metric_calls_used` records final worker telemetry when available, never inferred progress; it publishes at most one new immutable prompt version and exposes only lifecycle metadata through its SSE stream. See `apps/api/src/routes/prompt-optimizations.ts`.
- **Optimization dataset snapshot** — an immutable, job-local `dataset.version: 1` object containing a rubric/objective plus separately represented training and held-out validation examples. It is retained server-side; external job responses expose only its version, rubric, and split counts. It is not the mutable project Dataset resource. See `apps/api/src/lib/optimization-dataset.ts`.
- **Held-out validation evidence** — the candidate and source scores plus sample count from validation inputs that do not overlap the training split. Inputs with containment or at least 70% shared normalized tokens are not independent. It selects GEPA candidates and governs automatic promotion; a training score is diagnostic only. See `worker/gepa_worker.py`.
- **Optimization leakage check** — server-side normalized full-answer and material-span detection, including reordered token copies, that blocks a candidate from becoming a prompt draft or version when it copies expected-answer labels or example inputs. See `apps/api/src/routes/prompt-optimizations.ts`.
- **Review-required draft** — a safe optimization candidate retained with its diff and evidence when automatic promotion lacks sufficient independent held-out validation or held-out improvement. A same-project authenticated reviewer may promote it only while its source version remains current. See `apps/api/src/db/prompt-optimizations.ts`.
- **Dataset** — current project-scoped collection of `dataset_item`s. The proposed stable-resource, draft, and immutable-version lifecycle is specified in `docs/05-unified-dataset-workflow.md`. API: `/v1/datasets`.
- **Dataset version** — proposed immutable, ordered snapshot of a Dataset’s schema and item payloads. Evaluation runs must resolve and retain one concrete version, never a mutable draft. Display form: `slug@version`. See `docs/05-unified-dataset-workflow.md`.
- **Dataset item** — one JSON input/reference pair in a Dataset. Optional `source_trace_id` and `source_observation_id` preserve the production trace origin for regression workflows. API: `/v1/datasets/{id}/items`.
- **Evaluation** — proposed reusable project-scoped definition binding an agent target, Dataset selector, input/output mappings, evaluator configuration, and run defaults. It has immutable published definition versions. See `docs/05-unified-dataset-workflow.md`.
- **Evaluation run** — proposed execution after resolving immutable Evaluation, Dataset, agent/manifest, and evaluator versions. The existing MVP API/database term is **Experiment** (`/v1/experiments`), which remains the compatibility alias during migration.
- **Experiment** — current project-scoped evaluation run over a Dataset. It invokes either the configured OpenAI-compatible LLM or the development Codex-compatible CLI (`provider: "codex_cli"`), stores one result per Dataset item, scores with `exact_match` or `contains`, and emits one OTLP trace per item. API: `/v1/experiments`.
- **Benchmark suite** — project-scoped, longitudinal evaluation definition backed by a grounded golden Dataset whose items all provide expected outputs. Each run records its model/prompt label and ranks against prior runs. API: `/v1/benchmarks`.
- **Score** — numeric measurement on a trace or experiment item, keyed by `name`.
- **Feedback** — immutable `human.feedback` Score plus mutable project-scoped review state; negative `new` feedback appears in `/feedback` Needs review. API: `/v1/feedback`.
- **Governance policy version** — immutable project-scoped retention and ingress-redaction configuration. It has no effect until one version is explicitly approved; equivalent content is hash-idempotent. API/UI: `apps/api/src/routes/governance.ts`, `/governance`.
- **Retention run** — one bounded, project-scoped application of an approved governance policy. Its stored evidence has IDs, safe counts, status, and timings only; it never includes deleted source data. Summaries are available through `/v1/governance/retention/runs` and `/governance`. See `infra/db/migrations/0029_governance_policies.sql`.

## Storage roles

- **Postgres 16** — relational: agents, prompts, datasets, experiments, scores, projects.
- **ClickHouse 24** — OLAP: `traces`, `observations`. Partitioned by month; skip + bloom + tokenbf_v1 indexes.
- **Valkey 8** — event bus pub/sub fan-out (wire-compatible Redis). Future: BullMQ queues, rate-limit.

## Ingest

- **OTLP** — `POST /v1/otel/v1/traces`. Accepts OTel + `gen_ai.*` + OpenInference attrs and generation-only prompt provenance (`astraea.prompt.id`, `.version`, `.content_hash`). Per span: classify, sanitize metadata, write to ClickHouse, publish to bus (`trace.created` / `observation.created`). See `docs/03-otel-ingest.md`.

## Conventions

- **observation** (not span) for the data-model concept.
- **trace** (not request/run/session) in observability context.
- **generation** (not "LLM call") when `type` matters.
- **manifest** (not "agent config/spec").
- **organization** (not tenant) for the authenticated top-level scope; **project** (not organization) for its workspace and data scope.
- **score** (not metric/eval) in the scoring context.
- **SSE** for Server-Sent Events; avoid "websocket/live feed/push".
- **OTLP** for OpenTelemetry Protocol.
- **Valkey** (not Redis) — wire-compatible, but we ship Valkey.

---

## Keeping this file up to date

Add or edit a term here whenever:

1. **You introduce a new entity, route, page, or stored field** that has a user-facing name. Add it under the right section with a one-line "what it is" + a file pointer.
2. **You rename something** in the UI, API, or DB. Update this file in the same PR — keep the legacy alias here so search still finds it.
3. **You notice two names used interchangeably** for the same thing. Pick one (prefer the more specific / data-model name), add both to this file, then fix the codebase in the same PR.
4. **You add a classification rule** to `classifySpanType` (or change one). Update the `type` table above.

Style rules:

- Short. One line per entry if possible. Tables for taxonomies.
- Always include a file pointer (path:line or path) so the term is grounded in code.
- Don't duplicate the canonical doc — link to it (`docs/01-platform-design.md`, `docs/03-otel-ingest.md`, etc.).
- Prefer "preferred over X" notes over renames — the codebase has history; record it instead of pretending it didn't happen.
