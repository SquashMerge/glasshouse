# Hermes — 90-Day Roadmap

## Implementation status

| Phase | Window | Status | Notes |
|---|---|---|---|
| MVP — Foundation | Day 0–7 | Shipped | Local dev stack (Postgres 16, ClickHouse 24, Valkey 8, Hono API, React dashboard) behind `make dev`. PR: [#1](https://github.com/dsarlo/astraea/pull/1). Factory run: `phase-1-foundation`. |
| MVP — Ingest + trace viewer | Day 8–14 | Not started | OTLP receiver at `/v1/otel/v1/traces`; trace list / detail / search screens. Endpoint surface registered as 501 stubs. |
| MVP — Agent + Experiment | Day 15–21 | Not started | Agent + Experiment REST CRUD; `hermes.register()`; framework adapters; eval runner. Endpoint surface registered as 501 stubs. |
| MVP — Polish + dev mode | Day 22–30 | Not started | `hermes dev` single-binary; 3-tier prompt cache; prompts / datasets / experiments / settings UI. |
| Wedge | Day 30–60 | Not started | Framework expansion (LangGraph / CrewAI / Pydantic AI); HTTP endpoint registration; evaluator library; manifest version binding. |
| GitOps | Day 60–90 | Not started | GitHub Actions; manifest drift detection; atomic manifest rollback; `enterprise/` wheel. |
| Moat | Day 90–180 | Not started | Failure radar; judge calibration; closed-loop prompt optimization; voice-agent support. |

## Phase overview

```
DAY 0────30────60────90────120───180
│      │      │      │       │
│ MVP  │WEDGE │GITOPS│ MOAT   │SCALE
│      │      │      │        │
└──────┴──────┴──────┴────────┘
```

| Phase | Window | Goal | What ships |
|---|---|---|---|
| **MVP** | Day 0–30 | "We exist and you can run it" | Single-binary dev mode, OpenAPI + REST, OTLP ingest, basic SDK, 8-screen dashboard, ClickHouse schema, 3-tier prompt cache |
| **Wedge** | Day 30–60 | "Eval against your real agent with version binding" | Framework adapters (Agno/LangGraph/CrewAI/Pydantic AI), `hermes.evaluate()`, trace-to-dataset, HTTP endpoint registration (Maxim parity), per-env API keys, protected labels |
| **GitOps** | Day 60–90 | "Your CI is the eval runner, your PR is the workflow" | GitHub Actions, manifest-bound drift detection, atomic manifest rollback, CLI for HTTP path, sealed `enterprise/` wheel for v0 premium features |
| **Moat** | Day 90–180 | "We are the failure radar, we are the optimization loop" | Auto-clustering of drift events, judge calibration, closed-loop manifest optimization, voice-agent support, Quickwit for trace search v2 |

---

## Phase 1 — MVP (Day 0–30)

**Goal:** Stand up the platform end-to-end with the minimum surface needed to show "we have an Agent primitive, you can run this in 60 seconds, you can register an agent, you can see traces in the dashboard."

### Week 1 — Foundation (Days 1–7)

| Task | Owner | Deliverable | Status |
|---|---|---|---|
| OpenAPI 3 schema (the contract) | Backend | `openapi.yaml` covering `/v1/agents`, `/v1/experiments`, `/v1/traces`, `/v1/prompts`, `/v1/datasets`, `/v1/scores` | ✅ Shipped (Zod-as-source; 31 stub routes + `/openapi.json`) |
| Hono server bootstrap with @hono/zod-openapi | Backend | Generates OpenAPI from Zod schemas automatically; serves at `/reference` via Scalar UI | ✅ Shipped (`Bun.serve()` + Scalar at `/reference`) |
| Postgres schema (agents, projects, prompts, datasets, experiments, scores) | Backend | SQL migrations; runs on PostgreSQL 16 | ✅ Shipped (7 idempotent migrations; 10 tables) |
| ClickHouse schema (traces, observations) | Backend | SQL with partitioning + skip indexes + bloom filters + tokenbf_v1 | ✅ Shipped (8 indexes on `traces` + 5 on `observations`) |
| Redis setup (BullMQ + pub/sub + rate-limit) | Infra | Single Redis instance, persistent volume | ✅ Shipped as Valkey 8 (open-source Redis fork; wire-compatible — `ioredis` clients unchanged). AOF + named volume; BullMQ consumers deferred to a later phase. |
| React 19 + Vite + TanStack scaffold | Frontend | `npm create vite`, Tailwind, Shadcn/UI, openapi-fetch + openapi-typescript wired | ✅ Shipped (Vite + TanStack Router + Tailwind 3.4 + Shadcn-style; typed client wired in a later slice) |
| OpenAPI Codegen pipeline (TS + Python) | DevEx | `make codegen` regenerates typed clients from `openapi.yaml` | ✅ Shipped (`openapi-typescript` + `openapi-python-client`; byte-stable configs) |

### Week 2 — Ingest + trace viewer (Days 8–14)

| Task | Owner | Deliverable |
|---|---|---|
| OTLP receiver at `/v1/otel/v1/traces` | Backend | Accepts `gen_ai.*` + OpenInference attributes; validates; writes to ClickHouse + Postgres |
| Trace list screen | Frontend | TanStack Table; columns: time, name, agent, status, duration, score, input excerpt |
| Trace detail screen | Frontend | Nested span tree + agent graph + per-span I/O + scores; expandable observations |
| Trace search API | Backend | `GET /v1/traces/search?q=...&filter[...]` backed by ClickHouse; <50ms p95 for filtered, <100ms p95 for full-text |
| SDK: hermes-sdk (Python) | SDK | `pip install hermes-sdk`; exports the generated typed client |
| SDK: @hermes/sdk (TypeScript) | SDK | `npm install @hermes/sdk`; exports the generated typed client |
| OTel env-var integration | DevEx | Docs: "set OTEL_EXPORTER_OTLP_ENDPOINT, you're tracing" |

### Week 3 — Agent + Experiment (Days 15–21)

| Task | Owner | Deliverable |
|---|---|---|
| Agent resource (REST CRUD) | Backend | `POST /v1/agents`, `GET /v1/agents`, `GET /v1/agents/{id}`, `PATCH /v1/agents/{id}`, `DELETE /v1/agents/{id}` |
| `hermes.register()` SDK | SDK | Auto-introspects framework Agent objects; uploads manifest to platform; returns handle |
| Agno adapter | SDK | Calls `agent.to_dict()`, extracts name/model/instructions/tools/knowledge/storage/guardrails |
| Generic function adapter | SDK | `hermes.register_agent(name=..., invocation=fn, model=..., ...)` |
| Agent list + detail screens | Frontend | Two new dashboard pages |
| Experiment resource (REST CRUD) | Backend | `POST /v1/experiments`, `GET /v1/experiments`, etc. |
| `hermes.evaluate()` SDK | SDK | Wraps POST /v1/experiments; returns Experiment handle with .stream(), .wait(), .summary |
| Eval runner (Python worker) | Backend | BullMQ consumer; calls agent.invocation; runs evaluators; persists results |

### Week 4 — Polish + dev mode (Days 22–30)

| Task | Owner | Deliverable |
|---|---|---|
| SQLite dev mode | Backend | `hermes dev` command; single binary; zero Docker required |
| 3-tier prompt cache | Backend | L1 in-memory + L2 SQLite + L3 HTTP fetch |
| Prompt management endpoints | Backend | `GET /v1/prompts`, `POST /v1/prompts`, `POST /v1/prompts/{id}/versions`, `PATCH /v1/prompts/{id}/labels` |
| `hermes.prompts.get()` SDK | SDK | 5-method API; version pinning; fallback arg; cache TTL config |
| Experiments screen | Frontend | List, detail with live SSE updates, results table, comparison view |
| Prompts screen | Frontend | Versioned editor; label promotion UI |
| Dataset CRUD | Backend | `GET /v1/datasets`, `POST /v1/datasets`, item add/remove |
| Datasets screen | Frontend | List, items, "Run experiment" button |
| Settings screen | Frontend | API keys, members, environments, integrations |
| Show HN post | Marketing | "We built an OSS eval platform that treats your agent as a versioned contract. Here's why." |

**End of phase 1 demo:** A user can `pip install hermes-sdk`, register their Agno agent, run an eval against a sample dataset, see results stream into the dashboard in real time, all in under 5 minutes from `hermes dev`.

---

## Phase 2 — Wedge (Day 30–60)

**Goal:** Make the manifest primitive concrete. Expand framework coverage. Hit Maxim's "HTTP endpoint testing" parity. Ship per-environment API keys for the multi-deployment story.

### Week 5–6 — Framework expansion + HTTP path (Days 31–42)

| Task | Owner | Deliverable |
|---|---|---|
| LangGraph adapter | SDK | Reads `langgraph.json` + AST-walks graph module; captures nodes, edges, routing, model bindings |
| CrewAI adapter | SDK | Introspects `Crew.agents[]` + `Crew.tasks[]` + `Crew.process` |
| Pydantic AI adapter | SDK | Walks `agent.model`, `agent.instructions`, `agent.tools`, `agent.output_type` |
| HTTP endpoint registration | Backend | `POST /v1/agents` with `invocation.type=http`; stores URL + body template + headers |
| `hermes.register_endpoint()` SDK | SDK | Convenience wrapper around POST /v1/agents |
| Eval runner calls HTTP endpoints | Backend | Substitutes `${env:VAR}` secrets; renders body template; POSTs; parses response path |
| Trace ingestion from HTTP-invoked agents | Backend | Captures OTLP spans if agent emits them; falls back to HTTP request/response logging |
| OpenAI-compat proxy | Backend | `POST /v1/chat/completions`; minimal pass-through with trace capture |
| Maxim parity demo | Marketing | "Same HTTP endpoint testing as Maxim, plus Agent-as-typed-entity and version binding" |

### Week 7–8 — Eval runner maturity + SDK depth (Days 43–56)

| Task | Owner | Deliverable |
|---|---|---|
| Evaluator library | Backend | Wrap DeepEval + RAGAS metrics; ship 20+ built-in (hallucination, faithfulness, relevance, toxicity, etc.) |
| LLM-as-judge scorer | Backend | Calls external LLM with structured prompt; returns typed score |
| Code-eval scorer (sandboxed) | Backend | Firecracker microVM per evaluation; tenant-isolated; timeout + cost limits |
| Heuristic scorers | Backend | JSON validators, regex matchers, length checks |
| Custom evaluator registration | Backend | `POST /v1/evaluators` (user uploads Python function for their project) |
| `hermes.evaluate()` SDK depth | SDK | Streaming results, callbacks, cancel, experiment.wait(timeout) |
| Experiment comparison | Backend | `hermes.compare(agent=..., baseline=v11, candidate=v12, dataset=...)` |
| Dataset items from traces | Backend | `POST /v1/datasets/{id}/items` accepts trace_id; auto-fills input/output |
| `+ Add to dataset` UI | Frontend | Button on trace detail page; modal to map observation → dataset item |
| `Open in Playground` UI | Frontend | Pre-fills LLM span input; user mutates prompt/model; re-fires single call |
| Manifest diff viewer | Frontend | Side-by-side v11 vs v12; highlights changed fields |

### Week 9 — Multi-deployment + version binding (Days 57–63)

| Task | Owner | Deliverable |
|---|---|---|
| Per-environment API keys | Backend | Dev/staging/prod scoped keys; prod key requires admin role for mutations |
| Protected labels | Backend | `production`, `staging`, `development` labels only mutable by admin/owner |
| Version binding on eval runs | Backend | Each `ExperimentRun` snapshots `agent_version` (content hash); immutable per run |
| Manifest as oracle | Backend | Drift detection: trace's `agent.model` vs manifest's `model`; alert on mismatch |
| Agent registry UI | Frontend | Multi-agent view; tabs for versions; deployment history; drift events |
| `hermes.sync()` on startup | SDK | Re-introspects registered agents; pushes new version if content hash changed |
| `hermes.init(mode="strict")` | SDK | Raises on drift in CI; defaults to "sync silently" in dev |

**End of phase 2 demo:** A user with a LangGraph agent can `hermes.register(graph)` once. On every restart, Hermes auto-syncs the manifest if their code changed. They open a PR changing the routing rule. CI runs evals against the new manifest version with a `min_pass_rate` gate. The dashboard shows manifest v11 vs v12 side-by-side. They merge, prod picks up the new version within cache TTL.

---

## Phase 3 — GitOps + Moat (Day 60–90)

**Goal:** Make the GitOps workflow first-class. Ship the `enterprise/` wheel for v0 premium features. Lay groundwork for the moat (drift auto-clustering, judge calibration).

### Week 10 — GitHub Actions + CLI (Days 64–70)

| Task | Owner | Deliverable |
|---|---|---|
| `hermes-ai/run-evals@v1` Action | DevEx | GitHub Marketplace; runs `hermes evaluate` against agent + dataset |
| `hermes-ai/promote@v1` Action | DevEx | Promotes manifest version to env (production / staging) |
| `hermes-ai/drift-check@v1` Action | DevEx | Returns non-zero if manifest changed and no eval has run against new version |
| CLI: `hermes agents ...` | CLI | `add`, `list`, `show`, `update`, `delete`, `run`, `sync` |
| CLI: `hermes experiments ...` | CLI | `create`, `list`, `show`, `cancel`, `compare` |
| CLI: `hermes prompts ...` | CLI | `push`, `promote`, `rollback`, `list`, `get` |
| CLI: `hermes eval ...` | CLI | `run`, `compare`, `report` |
| Bash installer | DevEx | `curl -fsSL https://cli.hermes.ai/install.sh \| bash` |
| `repository_dispatch` webhook | Backend | Platform fires GH event when prompts change; user workflow listens |

### Week 11 — Manifest drift detection (Days 71–77)

| Task | Owner | Deliverable |
|---|---|---|
| Drift detection engine | Backend | Compares trace spans against registered manifest; emits `DriftEvent` records |
| Drift detection API | Backend | `GET /v1/agents/{id}/drift`, `GET /v1/agents/{id}/drift/stream` (SSE) |
| Drift dashboard | Frontend | Per-agent drift timeline; severity levels; resolution actions |
| Atomic manifest rollback | Backend | `git revert` of manifest restores prompt + tools + routing together |
| Per-PR preview env | Backend | Spin up staging pointer when `agents/` or `prompts/` touched |
| Webhook: GitHub commit-to-manifest | Backend | User's GH webhook commits manifest YAML to repo on every change |

### Week 12 — Enterprise wheel + v0 premium (Days 78–90)

| Task | Owner | Deliverable |
|---|---|---|
| `enterprise/` wheel skeleton | SDK | Sealed Python wheel under custom EULA (LiteLLM + tldraw pattern) |
| License key validation | SDK | Signed JWT; offline-checkable; air-gap compatible |
| SSO + SAML | Backend | Enterprise feature; gated by license key |
| SCIM provisioning | Backend | Enterprise feature |
| RBAC with audit logs | Backend | Enterprise feature |
| Multi-project org mode | Backend | Enterprise feature; org → projects → members |
| Org-level billing | Backend | Cloud feature; usage tracking; Stripe integration |
| Compliance report generation | Backend | SOC2 evidence packs from traces + evals; HIPAA audit trails |
| First paying customer | Sales | Land one design partner; transition from "free OSS" to "paid cloud" |

**End of phase 3 demo:** A regulated-industry team runs Hermes in their VPC. Their AI engineers commit `agent.yaml` changes via PR. CI runs evals, drift checks, and gates the PR. Merge auto-promotes to staging. Their compliance officer exports SOC2 evidence packs. They pay for the enterprise wheel.

---

## Phase 4 — Moat (Day 90–180)

**Goal:** Build the features nobody else has. The competitive research identified four moat features — we're shipping all four, with the highest-leverage first.

### Week 13–16 — Agent failure radar (Days 91–112)

**Why first:** The research's #1 universal pain point. "I have traces, but I don't know which ones matter."

| Task | Owner | Deliverable |
|---|---|---|
| Trace embedding pipeline | Backend | Embed `input_text` for new traces via OpenAI `text-embedding-3-small` |
| Embedding storage | Backend | Postgres pgvector table; partitioned by project |
| Auto-clustering engine | Backend | UMAP + HDBSCAN on trace embeddings; nightly batch + on-demand |
| Failure mode labels | Backend | Initial 8 modes: tool_misuse, retry_loop, goal_drift, timeout, auth_failure, hallucination, schema_violation, off_topic |
| `failureInbox` API | Backend | `GET /v1/failures?project_id=...&since=...` returns clustered groups |
| Failure inbox UI | Frontend | "12 new failure modes this week" landing page; one-click "Create regression test" |
| Alerting | Backend | Slack/email on new high-severity clusters |

**Differentiation:** Braintrust has eval CI but no failure discovery. Datadog has Trace Cluster Map but no AI-specific clustering. Latitude's GEPA auto-generates regression tests but no continuous failure surfacing. We have all three.

### Week 17–20 — Judge calibration (Days 113–140)

**Why second:** The research's #2 universal pain point. LLM-as-judge bias is well-documented (3 papers in 2025 confirm 31% disagreement on rating indeterminacy). No commercial platform ships robust calibration.

| Task | Owner | Deliverable |
|---|---|---|
| Bias audit engine | Backend | Per-judge bias report: rating distribution, disagreement rate, score stability on retries |
| Human-alignment loop | Backend | Sample N traces, collect human scores, compute judge-vs-human correlation |
| Calibration dashboard | Frontend | Per-judge alignment reports over time; drift detection on judge behavior |
| Auto-recalibration | Backend | Few-shot example regeneration when human disagreement > threshold |
| Multi-judge consensus | Backend | Run 3 judges per eval; weighted majority; flags high-disagreement items |
| Calibration API | Backend | `POST /v1/judges/{id}/calibrate`, `GET /v1/judges/{id}/alignment-report` |

**Differentiation:** Maxim/Braintrust/LangSmith all ship "use GPT-4 as judge" but no systematic calibration. We ship judge bias as a measurable, monitorable, improvable surface.

### Week 21–24 — Closed-loop prompt optimization (Days 141–168)

**Why third:** The research's #10 universal pain point. DSPy/GEPA exist as libraries but no vendor ships "give me eval data, here are 5 candidates, deploy the best."

| Task | Owner | Deliverable |
|---|---|---|
| GEPA integration | Backend | Wrap GEPA optimizer; expose as `POST /v1/prompts/{id}/optimize` |
| Multi-variant experiment runner | Backend | N prompt variants × M dataset items; collect evaluator scores |
| Pareto frontier analysis | Backend | Score vs cost / latency frontier; pick best by user-defined objective |
| Auto-deploy on winner | Backend | If configured: promote winning variant to env automatically |
| Rollback on regression | Backend | If post-deploy eval drops > X%, auto-rollback to previous version |
| Optimization dashboard | Frontend | Variant comparison view; Pareto chart; one-click promote |

**Differentiation:** DSPy/GEPA are libraries — users have to wire them up. We ship optimization as a UI surface with automated deployment. Braintrust's "AI-assisted optimization" is closest but partial.

### Week 25–28 — Voice agent support (Days 169–196)

**Why fourth:** The research's voice-agent gap is real but smaller. Defer to phase 4 unless user demand is strong.

| Task | Owner | Deliverable |
|---|---|---|
| Audio trace ingestion | Backend | OTLP attribute support for audio inputs/outputs |
| Audio storage | S3 | Raw audio files; ClickHouse stores metadata + duration |
| ASR/TTS breakdown | Backend | Latency decomposition: ASR / NLU / LLM / TTS per turn |
| Turn-taking detection | Backend | Identify interruption handling; compute interruption rate |
| WER per acoustic condition | Backend | Word error rate breakdown by accent/noise level |
| Voice trace viewer | Frontend | Waveform + transcript side-by-side |

**Differentiation:** Zero competitors have audio-native tracing in their eval platform. Voice-agent startups (Hamming, Cekura) are vertical-specific.

---

## Operational milestones

### Day 30 — First public release

- GitHub repo public, MIT-licensed
- `hermes dev` works in 60 seconds
- `pip install hermes-sdk` + `npm install @hermes/sdk` work
- 8 dashboard screens functional
- Show HN post

### Day 60 — First paying customer (target)

- 5+ design partner teams using Hermes in production
- 1+ team on paid cloud tier
- First feedback cycle on framework adapters

### Day 90 — Enterprise wheel GA

- `enterprise/` wheel in production
- First SOC2-bound customer using sealed wheel
- Compliance report generation working
- GitOps workflow documented and battle-tested

### Day 180 — Moat features complete

- Failure radar, judge calibration, prompt optimization all in GA
- 50+ teams using Hermes
- 5+ paying enterprise customers
- Competitive moat established

---

## Success metrics

| Metric | Day 30 target | Day 60 target | Day 90 target | Day 180 target |
|---|---|---|---|---|
| GitHub stars | 1,000 | 3,000 | 8,000 | 20,000 |
| Production users | 50 | 500 | 2,000 | 10,000 |
| Framework adapters | 3 | 6 | 8 | 12 |
| Dashboard screens | 8 | 10 | 12 | 14 |
| OSS contributors | 5 | 15 | 40 | 100 |
| Cloud customers | 0 | 5 | 25 | 100 |
| Enterprise wheel customers | 0 | 1 | 5 | 20 |
| Monthly cloud revenue | $0 | $5K | $30K | $150K |
| p95 trace search latency | <100ms | <80ms | <50ms | <30ms |

---

## What could go wrong

| Risk | Mitigation |
|---|---|
| Maxim ships Agent-as-typed-entity before we do | The 12-month window is conservative; ship MVP fast (Day 30). The manifest + drift detection compound advantage isn't easily copied. |
| Langfuse ships HTTP endpoint testing | Likely; they have the resources. But they don't have manifest-as-typed-entity OR drift detection OR GitOps. Three differentiators still. |
| Phoenix improves dashboard UX | Phoenix's strength is data science; production dashboards are a different audience. Stay focused on production eval. |
| A framework refuses to expose introspection APIs | Fall back to AST walking (LangGraph pattern). Universal fallback via HTTP endpoint registration. |
| Self-host is too hard for SMB | Phoenix-style single-binary dev mode lowers the bar. Document the `hermes dev` zero-config path prominently. |
| Compliance buyers won't touch a new vendor | Enterprise wheel with SOC2 evidence packs + HIPAA + air-gap install. Land a healthcare or finance design partner early. |
| Pricing backlash | Per-observation pricing (Langfuse model) not per-seat (LangSmith model). Generous free tier. Transparent pricing page. |
| Open-core resentment | Keep 95% of value in MIT core. Only premium features (SSO, audit, AI-assist) behind paywall. Publish exactly what's gated. |

---

## What we're NOT doing in 90 days

- Building an LLM gateway (LiteLLM owns this; we have minimal pass-through for convenience only)
- Building a no-code agent builder (LangChain, CrewAI, Agno own this)
- Building a data labeling tool (Labelbox, Scale AI own this)
- Building a model marketplace (Replicate, Hugging Face own this)
- Building GPU orchestration (Modal, Replicate own this)
- Competing on LLM cost tracking alone (Helicone owns this; we have cost as one of many signals)

Hermes stays focused on **agent evaluation and observability**. Adjacent features only when they directly serve that mission.

---

## Open questions to resolve during build

| Question | When to decide | Options |
|---|---|---|
| License for `enterprise/` wheel | Day 60 | Custom EULA (LiteLLM pattern) vs BSL (Sentry pattern) |
| Cloud pricing model | Day 45 | Per-observation (Langfuse) vs per-eval-run vs flat-fee |
| Default eval thresholds | Day 60 | Conservative (require ≥ baseline) vs aggressive (require ≥ 95% of baseline) |
| Voice agent depth | Day 90 | Full audio pipeline vs text-with-audio-metadata |
| Mobile app | Day 180 | Not planned; web dashboard only |
| Multi-region cloud | Day 180 | US-only first; EU second for compliance |

---

## The single sentence

In 90 days, we ship an MIT-licensed eval platform that registers any agent via a one-line SDK call, runs evals against the real deployed agent with version binding, gates PRs via GitHub Actions, and lets teams roll back atomic manifest units when something regresses. In 180 days, we add the moat — failure radar, judge calibration, closed-loop optimization — that nobody else has.