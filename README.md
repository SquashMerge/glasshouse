# Astraea

**Astraea** is an open-source evaluation platform for AI agents and LLM workflows. It treats your agent as a versioned contract — the manifest captures not just prompts, but the tools, routing rules, guardrails, and dependencies your agent runs with — so every eval run is bound to a known agent version, every regression is bisectable, and every rollback is atomic.

> Named for the Titan goddess of innocence and purity: the idea that an agent eval platform should be honest about what your agent actually is, not just optimistic about what it could be.

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

## Status

**This is a working design + research repo.** Implementation begins per `docs/02-roadmap.md`.

## Docs

- `docs/00-explainer.md` — General explainer (the "why" in plain terms)
- `docs/01-platform-design.md` — Full technical design (architecture, licensing, integration tiers, trace replay, prompt management, deployment/GitOps, tech stack, trace search, REST API)
- `docs/02-roadmap.md` — 90-day build plan (4 phases, week-by-week tasks, success metrics)
- `docs/research/` — Competitive analysis and framework research backing the design decisions
