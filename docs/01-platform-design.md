# Astraea Agent + LLM Evaluation Platform — Future Agent Registry Design

**Date:** July 4, 2026
**Status:** Archived pre-roadmap research, not an implementation commitment. The detailed Agent Registry, framework, HTTP, CI/GitOps, drift, and rollback examples below are superseded by `docs/02-roadmap.md`; they do not define P4/P5 scope. Current Astraea ships the foundation-first configured-LLM Experiment and observability loop; see `docs/02-roadmap.md` and `docs/06-dataset-feedback-future.md`.

---

## 1. The Wedge — "Manifest-bound eval of your real agent"

**One-sentence pitch:**
> "The OSS eval platform that calls your real deployed agent — prompts, tools, routing, guardrails bundled into one versioned manifest. Failures detected by deviation from manifest intent. Prompts + tools + routing optimized as one unit. GitOps-native, MIT-licensed, single-binary dev mode."

**Refined after competitive research:**
> "We call your real deployed agent — like Maxim, like Braintrust sandboxes, like LangSmith Deployment. But unlike them, your agent is a *versioned, typed entity* — `agent.yaml` captures prompts, tools, routing, and guardrails as one atomic unit. PRs change agents. CI runs evals against pinned versions. Drift between trace and manifest becomes a product surface, not a debug session."

**Why this wins:**
- Maxim owns "HTTP endpoint testing" but treats agents as black boxes (no manifest, no version binding, no drift detection).
- Braintrust / LangSmith require re-implementing your agent as a function — drifts from prod.
- Langfuse has versioned prompts but not versioned agents (no tool/routing/guardrail bundling).
- Nobody combines: (1) real-agent execution + (2) version binding + (3) multi-tenant Agent registry + (4) drift detection.
- 12–18 month lead time before incumbents close all four.

---

## 2. Three-Tier Integration (compatible with anything)

### Tier 1 — Zero-config OTLP (60 seconds)
```bash
# Current Astraea receiver configuration; replace these placeholders for your deployment.
AUTH=$(printf '%s:%s' "$UI_USERNAME" "$UI_PASSWORD" | base64)
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.example.com/v1/otel"
export ASTRAEA_PROJECT_ID="YOUR_PROJECT_UUID"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic $AUTH,x-astraea-project-id=$ASTRAEA_PROJECT_ID"
python my_agent.py    # works for any framework that emits OTel
```

### Tier 2 — SDK one-liner on existing framework objects (5 minutes)
```python
import hermes

# Agno (auto-uses agent.to_dict())
hermes.register(agno_agent, project="research-bot", env="production")

# LangGraph (reads langgraph.json + AST-walks graph module)
hermes.register(langgraph_compiled_graph, project="customer-support")

# CrewAI (introspects Crew.agents[] and Crew.tasks[])
hermes.register(crew, project="blog-pipeline")

# Pydantic AI (walks agent.model, agent.instructions, agent.tools)
hermes.register(pydantic_ai_agent, project="weather-bot")

# Raw function (universal fallback)
hermes.register_agent(name="my-llm", invocation=my_callable_fn, model="gpt-4o", ...)
```

### Tier 3 — HTTP endpoint registration (no SDK required, Maxim-style)
```http
POST /v1/agents
{
  "project": "research-bot",
  "env": "production",
  "name": "research-assistant",
  "invocation": {
    "type": "http",
    "url": "https://api.acme.com/agents/research/run",
    "body_template": {"input": "{{input}}"},
    "response_path": "output.response"
  },
  "manifest": { /* optional, for drift detection */ }
}
```

### Tier 4 — Manual YAML (escape hatch only)
For teams with hand-authored configs, non-Python agents, or governance workflows:
```yaml
# agent.yaml — checked into git
apiVersion: hermes/v1
kind: Agent
metadata:
  name: customer-support-router
spec:
  invocation: { type: http, url: ... }
  prompts: { router: production@7 }
  tools: { search_db: { ... } }
  routing_rules: [{ if: "user.tier=='premium'", model: claude-opus-4 }]
```

---

## 3. Agent as a Typed First-Class Entity

Every framework produces the same `AgentManifest` shape via `hermes.introspect(agent)`:

```python
AgentManifest(
    framework="agno",                  # auto-detected
    framework_version="2.6.22",
    agent_id="research-agent-v3",
    name="Research Agent",
    model={"provider": "openai", "name": "gpt-4o"},
    instructions=["You are a research analyst.", "Always cite sources."],
    tools=[{"name": "duckduckgo_search", "kind": "toolkit", "source": "agno"}],
    knowledge={"type": "vector_db", "backend": "lancedb"},
    storage={"type": "sqlite"},
    output_schema="ResearchReport",
    guardrails=[...],
    config_raw=agent.to_dict(),        # framework-native dump preserved
    content_hash="sha256:abc...",      # version identifier
    source_git_sha="abc123",
    captured_at="2026-07-04T...",
    introspection_method="agno.to_dict",
)
```

**Framework introspection ranking (best → worst):**
Agno (built-in `to_dict()`) ≈ Letta (`client.agents.export()`) ≈ CrewAI > Pydantic AI ≈ Mastra ≈ Vercel AI SDK v6 > OpenAI Agents SDK > AutoGen > LangGraph (hardest — no central object, prompts hidden in node functions) > DSPy > raw client.

**Agno adapter is ~10 lines** because `agent.to_dict()` does the work. Agno also has first-class versioning (`component.current_version`, `_version`, `_stage`, label retrieval via `get_agent_by_id()`).

**LangGraph adapter** reads `langgraph.json` + AST-walks the graph module — most work, but still zero user YAML.

---

## 4. Dual-Path Architecture — SDK + HTTP, Same Agent Entity

Both paths converge on the same `Agent` resource in the platform:

```
SDK PATH (source of truth: code)
──────────────────────────────────
hermes.register(my_agent)         ──┐
hermes.sync(my_agent) on startup  ──┤    Same Agent row,
                                     ├──► same agent_id,
HTTP PATH (source of truth: platform)     same versions
──────────────────────────────────     │
POST /v1/agents                   ──┤
PATCH /v1/agents/{id}             ──┤
hermes agents add (CLI)           ──┘
```

**Three eval-trigger surfaces, all sharing one runner:**

```python
# 1. SDK programmatic
hermes.evaluate(agent=agent, dataset="qa-100", evaluators=["accuracy","latency","cost"])
```

```yaml
# 2. GitHub Action CI gating
- uses: hermes-ai/run-evals@v1
  with: { agent: research-assistant, dataset: regression-suite, min_pass_rate: 0.85 }
```

```http
# 3. REST + Dashboard UI
POST /v1/experiments
{ "name": "prompt-v4-baseline", "agent_id": "ag_8f3e2a", "dataset": "qa-100", "evaluators": [...] }
GET  /v1/experiments/{id}/events       # SSE stream of live progress
```

---

## 5. Trace Replay — "+ Add to dataset" + "Open in Playground"

**Two buttons on every trace/span that do 80% of the work:**
- `[+ Add to dataset]` — captures observation input → DatasetItem with `sourceTraceId` back-link
- `[Open in Playground]` — one-off LLM-call replay with new prompt/model (zero coupling)

**Dataset experiment runner:** calls the user's actual agent (HTTP or SDK) with each dataset item's input; captures full sub-traces; runs evaluators; persists `ExperimentRunItem { datasetItemId, traceId, scores }`.

**The single most important field:** `DatasetItem.sourceTraceId` — without it, the user can't compare "did the new prompt beat the original."

---

## 6. SDK Prompt Delivery and Cache Policy (planned P4)

The future Python, TypeScript, and Java SDKs will resolve a managed prompt to
an immutable `(project_id, slug, version, content_hash)` identity, render it
locally, and emit that identity as generation provenance. They cache prompt
**definitions**, not rendered prompts or model responses.

The required baseline is a bounded in-process cache with stale-while-revalidate
and a content-hash-verified fallback bundle. A durable local cache is optional,
not a mandatory cross-language SQLite tier. Provider prefix caching is a
best-effort adapter capability; it cannot promise provider hits, retention, or
global eviction. The canonical proposal, API contract, tenancy rules,
invalidation/eviction model, and acceptance gates are in
[`docs/10-prompt-delivery-sdk-cache.md`](10-prompt-delivery-sdk-cache.md).

---

## 7. Deployment + GitOps

**Data model:** Immutable versions + mutable environment pointers (label-based).

**Reserved labels:** `production`, `staging`, `development` — protected from non-admin mutations (Langfuse's pattern).

**Per-environment API keys:** dev key can't accidentally promote to prod. Deployment context encoded in the key so app code stays env-agnostic.

**GitOps primitives:**
- `repository_dispatch` webhook when prompts change
- `hermes-ai/promote@v1` GitHub Action
- `hermes-ai/run-evals@v1` GitHub Action (with min_pass_rate gate)
- Per-PR preview env pointing at staging pointer
- Atomic manifest rollback = `git revert` of `agent.yaml` (rolls back prompt + tools + routing + guardrails together)

**CLI:**
```bash
hermes prompt push | promote | rollback | list
hermes agents add | list | show | update | delete | run
hermes experiments create | list | show | cancel
```

---

## 8. Tech Stack (final, consolidated)

```
FRONTEND:
  React 19 + Vite 5 + TypeScript 5
  React Router v6 (code-based routing, no Next.js)
  TanStack Query (server state) + TanStack Table (data grids) + TanStack Virtual (huge lists)
  Tailwind CSS + Shadcn/UI
  openapi-fetch + openapi-typescript (typed REST client from OpenAPI YAML)
  SSE via native EventSource (live updates)
  Lucide icons, Recharts for viz

API LAYER (TypeScript, Node):
  Hono for REST + SSE + OTLP receiver + OpenAI-compat proxy + webhooks
  @hono/zod-openapi for OpenAPI 3 schema generation
  Scalar or Stoplight Elements for API reference UI
  Redis pub/sub for SSE fan-out across pods

API LAYER (Python, FastAPI + Uvicorn):
  Eval runner worker
  LLM-as-judge scorers
  Code-eval sandbox (Firecracker)
  DSPy / GEPA prompt optimization
  DeepEval + RAGAS metric wrappers
  BullMQ worker consuming jobs

STORAGE:
  PostgreSQL 16 + pgvector       (relational, prompts, agents, experiments, scores)
  ClickHouse 24                  (traces, observations, partitioned by month)
                                 Skipping indexes + bloom filters + tokenbf_v1 full-text
                                 Targets: <50ms filtered, <100ms full-text
  Redis 7                        (BullMQ queue + L1 cache + pub/sub for SSE + rate-limit)
  S3 / MinIO                     (raw blobs, multimodal attachments, exports)
  SQLite                         (dev mode single-binary, zero deps)

SDKs:
  hermes-sdk (Python) — openapi-python-client + framework adapters
  @hermes/sdk (TypeScript) — openapi-fetch + framework adapters
  Both derive types from same OpenAPI YAML

LICENSE:
  MIT core
  Sealed `enterprise/` wheel under custom EULA (LiteLLM + tldraw pattern)

WIRE FORMATS:
  OTLP/HTTP at /v1/otel/v1/traces   (primary ingest)
  OpenAI-compat at /v1/chat/completions   (gateway mode)
  REST everywhere else   (/v1/agents, /v1/experiments, /v1/traces, /v1/prompts)
  SSE at /v1/experiments/{id}/events and /v1/traces/stream   (live updates)

DEPLOY:
  Docker Compose for self-host (full stack)
  Single-binary dev mode (SQLite + MinIO embedded) for `hermes dev`
  Kubernetes + Helm for production
```

**Why this combo (vs alternatives):**
- **REST not GraphQL:** Simpler, better caching, easier SDK consumers, same end-to-end typing via OpenAPI Codegen. SSE for live updates.
- **React + Vite not Next.js:** No SSR needed for authenticated dashboard. Lighter bundle, faster dev, no RSC mental-model tax.
- **Polyglot server (TS Hono + Python FastAPI):** TS for the sync API/web UI surface, Python for ML eval workloads. Same pattern as Langfuse v3, proven at billions-of-rows scale.
- **Postgres + ClickHouse:** Postgres for relational/transactional, ClickHouse for trace OLAP. Skip indexes + bloom filters + tokenbf_v1 full-text gives sub-100ms trace search.
- **SQLite dev mode:** Phoenix's "single binary, no Docker" wins GitHub stars. We adopt it.

---

## 9. Competitive Positioning — The Refined Wedge

### Universal pain points (from research) we address directly:
- **#4 Agent failure discovery** — manifest gives the "expected behavior" oracle for auto-clustering deviations
- **#5 CI/CD quality gates half-built** — GitOps workflow closes the gate
- **#10 No platform owns closed-loop prompt optimization** — atomic manifest (prompt + tools + routing) is the optimization unit

### Per-incumbent differentiation:
| vs | Their weakness | Our advantage |
|---|---|---|
| **Langfuse** | ClickHouse babysitting; evaluator "pending" bugs; no Agent entity | Single-binary dev mode; manifest as evaluator oracle |
| **LangSmith** | Pricing shock; LangChain lock-in; self-host Enterprise-only | MIT + self-host day one; framework-agnostic |
| **Braintrust** | No native gateway; no OSS; weaker agent eval; $249/mo Pro filter | OSS + agent-first + manifest-bound; open-core licensing |
| **Helicone** | "Depth of agent tracing keeps it off shortlists" | We're agent-first, not LLM-first |
| **Portkey** | "Has a lot of bugs, complexity too high, missing advanced analytics" | Same gateway surface + eval workflows first-class |
| **Maxim AI** | **The loudest direct competitor** — owns HTTP endpoint testing. But: no Agent-as-typed-entity, no version binding, no multi-tenant registry, no drift detection, closed-source | We bind to a versioned manifest contract; we don't just call an endpoint |
| **Phoenix** | Notebook-first; "doesn't have pretty dashboards"; weaker for prompt/cost | Production dashboard UX + the Agent primitive Phoenix doesn't have |
| **AgentOps** | 5K event cap; eval depth lags; no gateway | Larger free tier + full eval + optional gateway |

### The five non-obvious advantages:
1. **Manifest as "expected behavior" oracle** — auto-cluster deviations, not just traces
2. **Atomic manifest rollback** beats atomic prompt rollback
3. **Eval target stability through agent changes** — manifest version is the contract, code is implementation
4. **GitOps as primary UX** — PR is the workflow, not a UI re-implementation
5. **Single-binary dev mode** + enterprise scale (Phoenix + Langfuse combined)

---

## 10. Trace Search Performance — Beating Phoenix

**Why Phoenix is slow:**
- Single-process SQLite/Postgres + in-memory span search
- No proper full-text index on trace input/output
- ClickHouse migrations run in order before the production API accepts traffic; the same idempotent runner is available locally through `make ch-schema`
- Span search is O(N) scan

**Our ClickHouse schema (v1):**
```sql
CREATE TABLE traces (
    trace_id String, project_id String, name String,
    start_time DateTime64(3), end_time Nullable(DateTime64(3)),
    duration_ms Nullable(UInt32), status LowCardinality(String),
    user_id String, session_id String, agent_id String,
    agent_version String, env LowCardinality(String),
    tags Array(LowCardinality(String)),
    input_text String, output_text String,
    scores_summary String, metadata String
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(start_time)
ORDER BY (project_id, start_time, trace_id);

-- Skipping indexes for fast filtered scans
ALTER TABLE traces
    ADD INDEX idx_status status TYPE set(4) GRANULARITY 4,
    ADD INDEX idx_env env TYPE set(4) GRANULARITY 4,
    ADD INDEX idx_agent agent_id TYPE bloom_filter(0.01) GRANULARITY 4,
    ADD INDEX idx_user user_id TYPE bloom_filter(0.01) GRANULARITY 4,
    ADD INDEX idx_session session_id TYPE bloom_filter(0.01) GRANULARITY 4,
    ADD INDEX idx_tags tags TYPE bloom_filter(0.01) GRANULARITY 4;

-- Full-text indexes on input/output
ALTER TABLE traces
    ADD INDEX idx_input_text input_text TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4,
    ADD INDEX idx_output_text output_text TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4;
```

**Performance targets:**
| Query | Phoenix | Ours |
|---|---|---|
| Filter by project + time, no text | 200–800ms | <50ms |
| Full-text on input/output | 1000–3000ms (scan) | <100ms (tokenbf_v1) |
| Filter by tags + status + time | 300–1200ms | <50ms (skipping indexes) |
| Trace detail + observations | 100–500ms | <80ms |
| Aggregate (pass rate by agent, 30d) | 5–30s | <200ms |
| Live tail (last N minutes) | N/A | <50ms (MergeTree inserts) |

**Optional v2: Quickwit** (Rust-based, 10x faster than ClickHouse FTS, native BM25 + faceting). Trade-off: one more service to operate. Add only if search latency becomes a complaint.

**Search API:** `GET /v1/traces/search?q=quantum&filter[agent_id]=ag_xxx&filter[time.from]=...&filter[score.min]=0.8&sort=start_time:desc&expand=scores,agent`

---

## 11. REST API Surface (final)

```
# Agents
POST   /v1/agents
GET    /v1/agents
GET    /v1/agents/{id}
PATCH  /v1/agents/{id}
DELETE /v1/agents/{id}
POST   /v1/agents/{id}/sync
POST   /v1/agents/{id}/run
GET    /v1/agents/{id}/versions

# Experiments
POST   /v1/experiments
GET    /v1/experiments
GET    /v1/experiments/{id}
GET    /v1/experiments/{id}/results
GET    /v1/experiments/{id}/summary
GET    /v1/experiments/{id}/events     # SSE live progress
POST   /v1/experiments/{id}/cancel

# Prompts
GET    /v1/prompts
POST   /v1/prompts
GET    /v1/prompts/{id}
GET    /v1/prompts/{id}/versions
POST   /v1/prompts/{id}/versions
PATCH  /v1/prompts/{id}/labels

# Datasets
GET    /v1/datasets
POST   /v1/datasets
GET    /v1/datasets/{id}
GET    /v1/datasets/{id}/items
POST   /v1/datasets/{id}/items
DELETE /v1/datasets/{id}/items/{itemId}

# Traces
GET    /v1/traces
GET    /v1/traces/search
POST   /v1/traces/search
GET    /v1/traces/{id}
GET    /v1/traces/{id}/observations
GET    /v1/traces/{id}/scores

# Observations
GET    /v1/observations/{id}

# Scores
POST   /v1/scores
GET    /v1/scores

# Metrics
GET    /v1/metrics

# Live updates (SSE)
GET    /v1/experiments/{id}/events
GET    /v1/traces/stream
GET    /v1/agents/{id}/drift/stream
GET    /v1/prompts/{id}/stream

# Non-REST protocol endpoints (stay separate)
POST   /v1/otel/v1/traces              # OTLP ingest
POST   /v1/chat/completions            # OpenAI-compat proxy
POST   /v1/webhooks/{provider}
POST   /v1/files/upload
GET    /healthz, /readyz, /metrics
```

**All endpoints OpenAPI 3 documented, generated via @hono/zod-openapi.**

**Typed clients via OpenAPI Codegen:**
- TS: `openapi-fetch` + `openapi-typescript` → typed React hooks
- Python: `openapi-python-client` → typed SDK

---

## 12. Build Priority (90-day roadmap)

| Phase | What | Why |
|---|---|---|
| **Day 0–30 (MVP)** | OpenAPI schema + Hono server + React 19/Vite dashboard with 8 screens + SDKs for Agno + raw function + 3-tier prompt cache + SQLite dev mode + ClickHouse schema + OTLP ingest | Show HN: "We exist, we have an Agent primitive, you can run this in 30 seconds" |
| **Day 30–60 (wedge)** | Framework adapters (LangGraph, CrewAI, Pydantic AI) + `hermes.evaluate()` + `+ Add to dataset` + `Open in Playground` + HTTP endpoint registration (Maxim parity) + per-env API keys | "Look — when I run an eval against my deployed agent, my tools, routing, prompts, settings all come along" |
| **Day 60–90 (GitOps + moat)** | `hermes-ai/promote` + `hermes-ai/run-evals` GitHub Actions + manifest-bound drift detection + `hermes.compare()` (A/B manifest versions) + CLI for HTTP path | "Your CI is the eval runner. Your PR is the promotion. Your git history is the audit log" |
| **Day 90–180 (moat)** | Auto-clustering of drift events + judge calibration + closed-loop manifest optimization + voice-agent support (audio tracing) + Quickwit for trace search v2 | The long-term wedge features |

---

## 13. Files saved

- `/home/hermes/llm-eval-competitive-landscape.md` — 10-platform competitive analysis (33 KB)
- `/home/hermes/reports/agent-reexec-research.md` — Agent re-execution deep-dive vs 8 incumbents (41 KB)
- `/home/hermes/agent-eval-platform-research.md` — Framework introspection + registration patterns (29 KB)
- `/home/hermes/hermes-platform-design.md` — This consolidated design doc