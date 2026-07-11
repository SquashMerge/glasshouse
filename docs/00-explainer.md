# Hermes — General Explainer

## The 30-second pitch

Hermes is an open-source evaluation platform for AI agents and LLM workflows. You point it at your agent — any agent, any framework, any language — and it tells you whether that agent is actually working the way you think it is, lets you replay real conversations against new prompt versions, and stops bad changes from reaching production.

The part that's different: most eval platforms treat "agents" as a thing you re-implement in their eval framework, or as a single LLM call with a prompt. Hermes treats your **agent as a versioned contract** — the manifest captures not just prompts, but the tools, routing rules, guardrails, and dependencies your agent runs with. So when you change a prompt, the eval knows exactly which tool config and routing rule it was paired with. When you ship a regression, you can bisect it. When you roll back, you roll back the whole atomic unit, not just one prompt while the rest stays broken.

---

## What problem this solves

AI teams in 2026 are building agents that are mostly glue code. A typical production agent looks like this:

```
User message
    ↓
[ Routing layer: premium tier? → claude-opus; else → gpt-4o-mini ]
    ↓
[ Prompt template v7 (system + 5KB of conditional context) ]
    ↓
[ Tool call: search_db with RLS policy, returns 10 results ]
    ↓
[ Re-ranker with custom scoring ]
    ↓
[ Synthesizer prompt (different model, different prompt) ]
    ↓
[ Output guardrail: PII redaction + length cap + refusal rules ]
    ↓
[ Send via email API ]
```

The LLM call is maybe 30% of the actual behavior. The other 70% is routing, tools, prompts, guardrails, and business logic — all of which change independently, all of which can regress independently.

**The problem with every existing eval platform:** they evaluate only the LLM call. You write a "task" function in their framework, point it at an OpenAI call with the captured input, and get a score. But the score doesn't tell you whether the regression was in your routing logic, your tool config, your prompt template, or your guardrails. And the eval target drifts from production the moment your code changes.

**The problem with the "call my deployed agent" approach** (Maxim, LangSmith Deployment, Braintrust Modal): they call your deployed agent, but they don't bind to a known contract about what that agent *should* be doing. They capture the response, score it, and hope nothing changed since the trace was recorded.

**What Hermes does differently:** captures the manifest of what your agent *is* (prompts, tools, routing rules, guardrails, dependencies) as a versioned artifact. Then every eval run is bound to a specific manifest version. When something regresses, you can compare manifest v11 vs v12 to see exactly what changed. When you ship, you ship the whole atomic unit. When you roll back, you roll back everything together.

---

## Who this is for

**Primary users:**
- AI engineering teams building production agents (5-50 engineers)
- Platform / infra teams supporting multiple AI product teams
- Companies in regulated industries (healthcare, finance, government) that need audit trails of agent behavior

**Secondary users:**
- AI research teams running systematic prompt experiments
- LLM ops / observability teams standardizing on one platform

**Explicitly NOT for:**
- People who want a no-code agent builder (use LangChain's flow, Flowise, etc.)
- People who only want LLM cost tracking (use Helicone)
- People who are happy with single-call eval and don't have agents

---

## What it actually does, in plain terms

### 1. You point Hermes at your agent

Three ways, in order of friction:

**One-line SDK call** (5 minutes):
```python
import hermes
hermes.register(my_agent, project="research-bot", env="production")
```
Works for Agno, LangGraph, CrewAI, Pydantic AI, Mastra, Vercel AI SDK, OpenAI Agents SDK, and any custom code. The SDK introspects your agent's existing config — no YAML authoring.

**HTTP endpoint registration** (no SDK, like Maxim):
```
POST /v1/agents
{ "name": "research-assistant", "url": "https://my-app.com/agent", ... }
```

**Hand-authored YAML** (escape hatch for governance workflows, git-tracked):
```yaml
# agent.yaml
apiVersion: hermes/v1
kind: Agent
metadata: { name: customer-support-router }
spec:
  invocation: { type: http, url: ... }
  prompts: { router: production@7 }
  routing_rules: [{ if: "user.tier=='premium'", model: claude-opus-4 }]
```

### 2. Hermes captures the manifest

For every agent, Hermes stores:
- **Identity**: name, ID, project, environment
- **Configuration**: model, system prompt, tools (with their configs), knowledge base, storage
- **Logic**: routing rules, guardrails, hooks, retry policies
- **Dependencies**: Python version, package versions, secrets references
- **Provenance**: git SHA, framework version, capture timestamp
- **Version history**: every change ever made, with diffs

Two agents with the same content hash are the same agent. Two with different content hashes are different versions — even if your git SHA didn't change (someone tweaked a config at runtime).

### 3. You run evals

Three ways:

**Programmatically** (SDK):
```python
results = hermes.evaluate(
    agent=my_agent,
    dataset="qa-100",
    evaluators=["accuracy", "latency", "cost", "tool_correctness"],
)
```

**From CI** (GitHub Action):
```yaml
- uses: hermes-ai/run-evals@v1
  with: { agent: research-assistant, dataset: regression-suite, min_pass_rate: 0.85 }
```

**From the UI** (no code):
Click "New experiment" → pick agent, pick dataset, pick evaluators, click Run. Watch results stream in live.

### 4. Hermes tells you things you couldn't see before

- **Drift detection**: your manifest declared `if premium → opus`, but production traces show `gpt-4o-mini` getting premium requests. That's drift. Hermes flags it.
- **Prompt change impact**: manifest v11 vs v12, side-by-side, same dataset. Pass rate +6pp on the new prompt, but p95 latency +200ms. You decide.
- **Cost regression**: prompt v12 added a few words. Token cost went up 15%. Now you know.
- **Tool failure mode**: 8% of production runs are timing out on `search_db`. Drill into the traces, see the pattern, add it as a regression test.
- **Atomic rollback**: that prompt change broke something downstream. `git revert` the manifest. Everything — prompt, tools, routing — reverts together.

### 5. You ship the change confidently

PR-based workflow:
1. Engineer opens PR changing the prompt
2. CI runs the eval suite against the new manifest version
3. If scores regress below the threshold, PR is blocked from merging
4. If scores pass, merge auto-promotes the new manifest version to production
5. All production agents pick up the new version within their cache TTL

Audit trail: every promotion is logged with who, when, what version, what scores.

---

## What makes this unique

### The four things nobody else combines

1. **Real-agent execution** — Hermes calls your actual deployed agent with all its tools, routing, and business logic intact. Same coverage as Maxim, LangSmith Deployment, Braintrust sandboxes.

2. **Version binding** — Every eval run is pinned to a specific manifest version (content hash of the full agent config). Same evaluation against v11 gives you a different score than v12 — and you can see exactly why because the manifest diff is right there.

3. **Multi-tenant Agent registry** — Your project has many agents (chatbot, RAG pipeline, router, summarizer), each with versions, environments, deployment history. Other platforms treat "agent" as an endpoint URL or a Python function — Hermes treats it as a first-class entity with a UI.

4. **Drift detection** — The manifest is the "expected behavior" oracle. When production traces diverge from the manifest (wrong prompt version, wrong model for tier, missing guardrail call), Hermes flags it as drift. No other platform does this.

The competitive research validated this gap explicitly: "Maxim has the right primitive but no Agent-as-typed-entity. Braintrust has Function versioning but no first-class Agent. LangSmith Deployment is closest for LangChain. No platform has all four pillars tightly integrated."

### Why the manifest pattern matters

Most engineering teams are familiar with the pain of "what did we actually ship?" For AI agents, this is amplified because:

- **Prompts change without code review** (a PM edits a prompt in the platform UI, ships it, no one knows)
- **Tool configs drift** (someone updated a connection string in prod but forgot staging)
- **Routing logic lives in 5 places** (gateway config, agent code, prompt template, environment variable, post-processor)
- **Rollback is partial** (you can roll back the prompt but not the tool config it depended on)

The manifest solves all four by making "what is this agent" a single, versioned, reviewable artifact.

### Why "compatible with anything" matters

There are 10+ major agent frameworks (Agno, LangGraph, CrewAI, Pydantic AI, Mastra, Vercel AI SDK, Letta, AutoGen, OpenAI Agents SDK, Claude Agent SDK) plus 100+ raw LLM client patterns. No team wants to be told "rewrite your agent in our framework." Hermes accepts:

- **OTLP/HTTP** at `/v1/otel/v1/traces` (any framework that emits OpenTelemetry)
- **OpenAI-compat** at `/v1/chat/completions` (any OpenAI-compatible client — change one base URL)
- **SDK adapters** for 8+ frameworks (introspect existing Agent objects, no code rewrite)
- **HTTP endpoint registration** for black-box agents (Maxim-style)
- **Hand-authored YAML** as the last resort

The single platform works regardless of which framework your team picked or picks next year.

### Why OSS + single-binary dev mode matters

Most enterprise AI teams have a procurement gate: "no closed-source tools touching customer data." Langfuse has proven MIT + self-host is a viable business (they're at scale). Phoenix has proven Apache 2 + single-binary dev mode wins GitHub stars. Hermes combines both: MIT license + single-binary `hermes dev` mode (SQLite only, zero Docker) for instant first-run, plus full Docker Compose / Kubernetes for production self-host.

The dev-mode difference is real: `cargo install hermes && hermes dev` gets you to "first trace visible in dashboard" in 60 seconds. Compare to Langfuse's first-run which requires standing up Postgres + ClickHouse + Redis + S3. For evaluation, the dev loop matters.

---

## The high-level architecture, in one diagram

```
┌─────────────────────────────────────────────────────────────┐
│                  YOUR CODE (the agent)                       │
│                                                              │
│   SDK auto-instruments via framework adapter                 │
│   OTLP env var for tracing (zero code change)                │
│   SDK one-liner for manifest registration                    │
└──────────────────────────┬──────────────────────────────────┘
                           │  OTLP traces + REST mutations
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  HERMES PLATFORM (self-hosted or cloud)                       │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Ingest API (Hono / TypeScript)                      │    │
│  │  • OTLP receiver at /v1/otel/v1/traces             │    │
│  │  • OpenAI-compat proxy at /v1/chat/completions      │    │
│  │  • REST endpoints /v1/agents, /v1/experiments, ...  │    │
│  │  • SSE endpoints /v1/experiments/{id}/events        │    │
│  └──────────────────────────────────────────────────────┘    │
│                           │                                   │
│                           ▼                                   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Storage (Postgres + ClickHouse + Redis + S3)        │    │
│  │  • Postgres: agents, experiments, prompts, datasets  │    │
│  │  • ClickHouse: traces, observations, scores         │    │
│  │  • Redis: queue (BullMQ), L1 cache, SSE pub/sub     │    │
│  │  • S3: raw payloads, multimodal attachments         │    │
│  └──────────────────────────────────────────────────────┘    │
│                           │                                   │
│                           ▼                                   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Python Worker (FastAPI + BullMQ)                    │    │
│  │  • Eval runner (calls user agents, runs scorers)     │    │
│  │  • LLM-as-judge scorers (GPT-4 / Claude)             │    │
│  │  • Code-eval sandbox (Firecracker)                  │    │
│  │  • Prompt optimization (DSPy / GEPA)                 │    │
│  └──────────────────────────────────────────────────────┘    │
│                           │                                   │
│                           ▼                                   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Web Dashboard (React 19 + Vite)                    │    │
│  │  • 8 screens: traces, agents, experiments, prompts   │    │
│  │  • SSE-powered live updates                          │    │
│  │  • OpenAPI-typed via openapi-typescript              │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
                  GitHub Actions + CLI
                  (GitOps workflow)
```

---

## What's open vs paid (LiteLLM-style)

**Free, MIT-licensed core:**
- Full platform: tracing, eval, prompt management, agent registry
- Self-host in Docker Compose or `hermes dev` single-binary mode
- All 8 dashboard screens
- SDKs for Python + TypeScript
- CLI + GitHub Actions
- Framework adapters for all major frameworks
- Single-tenant (one project per deploy)

**Paid, sealed `enterprise/` wheel:**
- Multi-tenant / org mode (multiple projects under one deployment)
- SSO + SAML + SCIM
- RBAC with audit logs
- AI-powered features (eval-suggestion agent, prompt optimization agent)
- Compliance reports (SOC2 / HIPAA / ISO 27001 evidence packs)
- SLA + dedicated support

**Cloud version** (managed):
- Hosted single-tenant (you bring data, we run it)
- Free tier: 50K observations/mo, 1 project, 1 user
- Pro: usage-based pricing, multi-project, multi-user
- Enterprise: custom SLA, dedicated tenant, compliance bundle

This mirrors the LiteLLM pattern: MIT core + commercial EULA on a sealed `enterprise/` Python wheel. Avoids the backlash of BSL/SSPL licenses (HashiCorp lost deals to OpenTofu; Elastic walked SSPL back to AGPLv3). Keeps procurement simple.

---

## What's unique, summarized

1. **Manifest-bound eval** — versioned contract between your code and the eval system. Same eval against v11 vs v12, with explicit diffs.
2. **Real-agent execution** — calls your deployed agent, not an LLM with a captured input. Same coverage as Maxim + Braintrust + LangSmith Deployment.
3. **Compatible with anything** — OTLP ingest for any framework, OpenAI-compat for any client, SDK adapters for 8+ frameworks, HTTP endpoint registration for black-box agents.
4. **Drift detection** — manifest as "expected behavior" oracle. No other platform catches "the agent used the wrong model for premium tier."
5. **GitOps-native** — PR is the workflow, manifest is the unit, CI is the eval runner, merge auto-promotes. Atomic rollback via `git revert`.
6. **OSS + single-binary dev mode** — `hermes dev` in 60 seconds. No Docker required for getting started.
7. **Live updates everywhere** — SSE pushes new traces, experiment progress, drift events, prompt versions to the dashboard in real time.
8. **Fast trace search** — sub-50ms filtered queries, sub-100ms full-text search (ClickHouse with skip indexes + bloom filters + tokenbf_v1). Phoenix is 10-30x slower.

---

## The non-goals

- **Not a no-code agent builder.** Use LangChain, CrewAI, or Agno for that.
- **Not an LLM gateway.** Use LiteLLM or Portkey if you just need routing. (Hermes has a minimal gateway at `/v1/chat/completions` for convenience, not as a primary feature.)
- **Not an LLM cost dashboard.** Use Helicone if that's all you need.
- **Not a single-call LLM eval tool.** Use Promptfoo or Braintrust Eval if your agents are simple.
- **Not a vendor-locked SaaS.** Hermes is MIT, self-hostable, and your data never leaves your infrastructure unless you opt into cloud.

---

## Who would choose this vs the alternatives

**Switch from Langfuse** if: you have agents with non-trivial routing/tools/guardrails that Langfuse's prompt-only versioning can't capture.

**Switch from LangSmith** if: pricing shock, LangChain lock-in, or you need self-host.

**Switch from Braintrust** if: you want OSS, or your eval target is a deployed agent (not a function).

**Switch from Helicone** if: you need more than LLM-cost-tracking — actual agent eval.

**Switch from Maxim** if: you want OSS, or you want the agent as a typed first-class entity (not just an endpoint URL).

**Switch from Phoenix** if: you want production-grade dashboards, prompt management, and agent features Phoenix doesn't have.

**Stick with the incumbent** if: you're happy with the eval-as-function pattern, you don't need manifest binding, and your team is < 5 engineers building simple single-call LLM apps.

---

## TL;DR

Hermes is the eval platform that treats your agent the way your engineering team treats production code — versioned, reviewable, CI-tested, atomic-rollback-able. MIT-licensed, framework-agnostic, single-binary dev mode, manifest-bound eval. The combination of those four properties is the gap nobody else has filled.