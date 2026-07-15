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

## SSE endpoints (all in `apps/api/src/routes/trace-events.ts`)

- `GET /v1/traces/events` → `streamTraceEvents` — broadcasts new traces. Stays open.
- `GET /v1/observations/events` → `streamObservationEvents` — broadcasts new observations. Stays open.
- `GET /v1/traces/{id}/events` → `streamTraceDetailEvents` — single trace: snapshot + filtered live observations + closes after `TRACE_COMPLETE_GRACE_MS` of inactivity.

## Core entities

- **Project** — tenancy boundary (`project_id` on everything). Postgres, UUID-keyed.
- **Agent** — versioned, typed entity. Multi-tenant, versioned, has a version history.
- **Manifest** — serialized form of an Agent (prompts + tools + routing + guardrails + knowledge + deps as one atomic unit). Pinned to eval runs for bisectable regressions and atomic rollback.
- **Prompt** — immutable single-role Mustache template, scoped to a Project; its canonical public ID is the Project-local slug, while `slug@version` is display-only. See `apps/api/src/db/prompts.ts`.
- **Prompt provenance** — `GET /v1/prompt-provenance/{id}` reports whether the scoped `(slug, version, content_hash)` tuple is `active`, `deleted`, or `unknown`; it does not expose source or render data. See `apps/api/src/routes/prompt-provenance.ts`.
- **Prompt tombstone** — immutable `(project_id, slug)` reservation left by a hard deletion; prevents canonical prompt ID reuse. See `infra/db/migrations/0009_prompt_management_canonical.sql`.
- **Prompt deletion audit** — immutable, content-free deletion record: project ID, internal prompt ID, slug, deleting actor, timestamp, and deleted version count. See `infra/db/migrations/0009_prompt_management_canonical.sql`.
- **Dataset** — collection of `dataset_item`s, scoped to a Project.
- **Experiment** — Agent run over a Dataset, produces scores per item.
- **Score** — numeric measurement on a trace or experiment item, keyed by `name`.

## Storage roles

- **Postgres 16** — relational: agents, prompts, datasets, experiments, scores, projects.
- **ClickHouse 24** — OLAP: `traces`, `observations`. Partitioned by month; skip + bloom + tokenbf_v1 indexes.
- **Valkey 8** — event bus pub/sub fan-out (wire-compatible Redis). Future: BullMQ queues, rate-limit.

## Ingest

- **OTLP** — `POST /v1/otel/v1/traces`. Accepts OTel + `gen_ai.*` + OpenInference attrs. Per span: classify, write to ClickHouse, publish to bus (`trace.created` / `observation.created`). See `docs/03-otel-ingest.md`.

## Conventions

- **observation** (not span) for the data-model concept.
- **trace** (not request/run/session) in observability context.
- **generation** (not "LLM call") when `type` matters.
- **manifest** (not "agent config/spec").
- **project** (not tenant/workspace/org) — tenancy boundary.
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
