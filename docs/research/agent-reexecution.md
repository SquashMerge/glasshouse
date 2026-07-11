# Agent Re-Execution in LLM Eval/Observability Platforms

**Research date:** July 4, 2026
**Researcher:** Hermes subagent
**Question:** When existing platforms "replay a trace" or "run an experiment," do they call the user's **actual deployed agent/workflow** (with all its business logic, tools, custom routes, settings, and prompts), or do they just call an **LLM with the captured input**? What gets lost in the gap?

---

## TL;DR (the deliverable)

**The user's premise is essentially correct but slightly off-axis.** Every major platform has an "agent-aware" mode, but in practice, most teams still end up either:

1. **(a) Proxy-only mode:** the platform captures LLM traffic and replays raw LLM calls — Helicone, Portkey.
2. **(b) User-defined `task` function mode:** the platform calls a Python/JS function the user provides that *can* call their agent — LangSmith, Braintrust, Phoenix, Langfuse `run_experiment`.
3. **(c) True "call my deployed agent" mode (rare):** Maxim calls the user's HTTP endpoint, Braintrust calls a user-executed HTTP server or runs the user's code in a Modal sandbox, LangSmith deploys the user's LangGraph and *itself runs* it inside the platform.

**Genuinely missed:** #c, the "you register your agent endpoint once and the platform invokes it directly with the trace's input, preserving prompts/tools/routes/settings/version drift protection" pattern. **Maxim owns this position** in the current market. Laminar and Braintrust's sandboxes are close. The user's differentiator is valid, but it's not uncontested — it's a *thin* gap with several incumbents nibbling at it.

**Synthesis at bottom.** The rest of this report is raw evidence.

---

## Platform-by-Platform Findings

### 1. Langfuse

**What gets re-executed?** Whatever the user puts in the `task` callable (Python or JavaScript). Default examples in their docs call `OpenAI().chat.completions.create(...)` directly — i.e., a plain LLM call. To hit your actual agent, you replace the LLM call with `await my_agent.run(input)`.

**Two distinct modes exist:**

- **Experiment Runner SDK** (`langfuse.run_experiment`, `dataset.run_experiment`): the SDK ships a `task` function the user defines, runs in **the user's process** (their CI, their laptop, their server). The Langfuse SaaS only sees the resulting traces.
- **Remote / Webhook-driven experiment** (Sept 2025): Langfuse UI dataset page → user registers a **webhook URL** to a user-owned evaluation service. Langfuse POSTs the dataset + config to the webhook; **the user's service runs their own code** (typically: fetch dataset from Langfuse, call their app, push scores back). This is the closest Langfuse has to "call my deployed agent."

**User docs, verbatim** (Remote Experiment Webhook section):

> "Your webhook receives the request, fetches the dataset from Langfuse, **runs your application against the dataset items**, evaluates the results, and ingests the scores back into Langfuse as a new Experiment run."
> ([langfuse.com/docs/evaluation/dataset-runs/remote-run](https://langfuse.com/docs/evaluation/dataset-runs/remote-run))

- **How user registers agent:** Python `task=my_task` function in user code; OR a webhook URL pointing at user's HTTP endpoint. CI/CD via `langfuse/experiment-action` (GitHub Action).
- **Business logic preserved:** Whatever the user's `task` calls preserves. If the task function calls their agent → fully preserved. If the task is just a bare LLM call → only LLM is evaluated.
- **What gets lost:** The "task" indirection means Langfuse has no first-party view of the agent — it just receives the resulting spans. Multi-tenant agent registry? Each Langfuse project is effectively one agent (defined by whatever `task` you give it). Versioning is on **prompts**, not on the agent itself.
- **Multi-tenancy:** Yes — projects are siloed workspaces with their own datasets, prompts, scores. But you don't register "an agent" as an entity; you just point experiments at code. Multiple "agents" per project = multiple `task` functions in different scripts.
- **Recent additions:** Versioned dataset experiments (Feb 2026), Experiment Runner SDK.

---

### 2. Braintrust

**What gets re-executed?** The user-defined `task` function passed to `Eval(...)`. Per their own docs:

> "Task — the function being evaluated. Typically an LLM call, but can be any logic: a multi-step agent, a retrieval pipeline, or a custom workflow."
> ([braintrust.dev/docs/evaluate](https://www.braintrust.dev/docs/evaluate))

**Three execution paths:**

1. **Inline SDK** (`Eval("Project", { task, data, scores })`): task runs in user's Python/JS process.
2. **Remote Evals / Dev Server** (`bt eval --dev`): Braintrust spins up `http://localhost:8300` exposing the user's task; the Braintrust UI calls it. The user's full local code is what runs.
3. **Sandboxes** (`braintrust push` + Modal): User pushes a Docker image to a Modal sandbox; **Braintrust executes the user's full code/agent inside a hosted container**. This is the most "call my actual deployed agent" path Braintrust offers — the user's runtime, model weights, secrets, MCP servers, all execute inside Braintrust's sandboxed compute.

**Bonus:** Braintrust also has **Deploy Functions** — serverless hosted tools, prompts, scorers (Python/TS pushed via `bt functions push`), with versioning, isolation in AWS Lambda VPC environments, and **invoke by slug over REST**. Docs explicitly call out "Workflows" as a function type "in beta" with "agent deployment via SDK is coming soon."

- **How user registers agent:** `Eval({ task: fn })` in code; OR `bt eval --dev` exposing an HTTP dev server; OR `braintrust push` to a Modal sandbox; OR deploy functions serverless.
- **Business logic preserved:** Fully — same code that runs in production is what runs in eval. Sandbox path gives you environments, dependencies, system packages, GPU access.
- **What gets lost:**
  - Inline SDK doesn't have a unified agent identity. You'd version-control your `task` yourself.
  - Functions are versioned but not auto-bound to a trace input (you write `invoke({ project, slug, input })`).
  - Workflows in beta; "agent deployment via SDK is coming soon" (per docs as of July 2026).
- **Multi-tenancy:** Projects (`projects.create({name})`) are the primitive. Tools, prompts, scorers, workflows live inside projects. Yes, multiple agents per project — each is just a separate `Eval` script or a separate pushed function.

---

### 3. Phoenix (Arize)

**What gets re-executed?** Two distinct features, often confused:

- **Span Replay** (Phoenix Playground): user picks **a single LLM span** from a captured trace → Phoenix Playground re-invokes the LLM call against that prompt with user-mutable model + parameters. Only replays the **single LLM step**, not the agent. From their docs:
  > "Replay LLM spans traced in your application directly in the playground... If you've ever wanted to go back into a multi-step LLM chain and just replay one step to see if you could get a better outcome, well you can with Phoenix's Span Replay."
  > ([arize.com/docs/phoenix/prompt-engineering/overview-prompts/span-replay](https://arize.com/docs/phoenix/prompt-engineering/overview-prompts/span-replay))

- **Dataset Experiments** (`px.experiments.run_experiment`): user provides a Python `task` callable plus a dataset. Phoenix runs `task(dataset_item)` and compares outputs.
  > Task can call any logic, including a full agent.
  > ([docs.arize.com/phoenix/datasets-and-experiments](https://docs.arize.com/phoenix/datasets-and-experiments))

- **How user registers agent:** Code-first, notebook-driven. `task` is a Python function in your notebook/code. No built-in "webhook my endpoint" pattern. No first-class "agent deployment" notion.
- **Business logic preserved:** Fully — `task` is unrestricted Python. OpenTelemetry auto-instruments most LLM/agent frameworks (LangGraph, AutoGen, etc.).
- **What gets lost:**
  - No multi-tenant agent registry.
  - Span replay is **LLM-step level** — it does NOT re-execute an agent's full tool-chain.
  - Phoenix is open-source-first, so the user's agent runs in their environment or Phoenix Cloud; no hosted execution model in OSS Phoenix.
  - Note: Arize **AX** (commercial, separate product) is more enterprise but adds a billing friction (separate product from Phoenix).
- **Multi-tenancy:** Phoenix "projects" hold experiments/datasets/spans; you can have many experiments per project. But each is ad-hoc — no Agent-as-an-Entity.
- **Span-based pricing model** specifically skews against agents per Laminar's analysis above (10-minute × 15-tool agents produce 1,000-span traces).

---

### 4. LangSmith

**What gets re-executed?** A user-defined `target` function — exactly the LangSmith analog of `task`.

> "The target system or experiment(s) to evaluate. Can be a function that takes a dict and returns a dict, a langchain Runnable, an existing experiment ID, or a two-tuple of experiment IDs."
> ([reference.langchain.com/python/langsmith/evaluation/_runner/evaluate](https://reference.langchain.com/python/langsmith/evaluation/_runner/evaluate))

Their docs explicitly show how to make `target` call the user's agent:

```python
def target(inputs: dict) -> dict:
    messages = inputs["messages"]
    response = agent.invoke({"messages": messages})  # Replace invoke with whatever you use to call your agent
    return response
```

> ([docs.langchain.com/langsmith/define-target-function](https://docs.langchain.com/langsmith/define-target-function))

**Three modes:**

1. **`evaluate(target=target_function)`** — runs in user's local process.
2. **LangSmith Deployment** (`langgraph deploy`): LangSmith **hosts and runs the user's LangGraph agent** in their cloud (or self-hosted hybrid). Studio and evals then call the **deployed agent endpoint** — this is the closest thing to "register your agent with the platform" in the LangSmith world. Evals run against the deployed URL, preserving all prompts, tools, settings, version pinning.
   > "LangSmith Deployment is a workflow orchestration runtime purpose-built for agent workloads... framework-agnostic which means you can deploy agents built with: [LangGraph, Google ADK, CrewAI, AutoGen, Claude Agent SDK, Strands...]"
   > ([docs.langchain.com/langsmith/deployment](https://docs.langchain.com/langsmith/deployment))
3. **Studio**: visual agent IDE. Test the running graph, iterate on prompts, replay from a span, add dataset rows from history. "1 Click deploy to LangSmith Cloud." Real interactive debugging against the deployed/runtime graph.
4. **Harbor integration** (July 2026): LangSmith hooks into Harbor for sandbox-isolated agent evals: "Run agents in isolated, reproducible sandboxes" — agent runs in containers under LangSmith's control.

- **How user registers agent:** Python `target` function in code, OR `langgraph deploy` to push the agent into LangSmith-managed infrastructure, OR Studio (which points at LangGraph dev server or deployed agent).
- **Business logic preserved:**
  - `target` is unrestricted, can call anything.
  - Deployed LangGraph: fully preserved (entire graph state, checkpoints, memory, tools).
  - Framework-agnostic: LangGraph, ADK, CrewAI, AutoGen, Claude Agent SDK, Strands via wrapper.
- **What gets lost:**
  - Outside LangChain ecosystem, `target` is just whatever you call — no first-class agent registry.
  - Multi-turn eval is well-supported for LangChain/langgraph but `target` is your responsibility to wire up.
  - To get *true* hosted-agent testing, you must use LangSmith **Deployment** (paid tier with hybrid option for self-hosted agents).
- **Multi-tenancy:** Workspace → Project → Datasets → Experiments. Multiple "agents" = multiple deployed graphs OR multiple `target` functions. Workspace-scoped evaluators can be attached to many projects.

---

### 5. Maxim AI

**The platform that most closely matches the user's "call my actual agent" vision.**

**What gets re-executed?** Maxim POSTs `{ input, ... }` to the user's HTTP endpoint with a templated body (`{{column_name}}` substitution), then runs evaluators on the response. **The user's deployed service handles everything** — tools, RAG, custom routing, multi-step planning, business logic, guardrails.

> "If your agent is hosted externally, you can use HTTP Endpoint Evaluation. This enables you to send payloads to your agent's API endpoint and evaluate the response."
> ([getmaxim.ai/resources/faqs/simulation-and-evaluation/how-to-evaluate-ai-agents-and-agentic-workflows](https://getmaxim.ai/resources/faqs/simulation-and-evaluation/how-to-evaluate-ai-agents-and-agentic-workflows))

**Pre/post scripts:** User writes JavaScript `prescript`/`postscript` functions in the UI that mutate Maxim's outgoing request and the agent's response. These can call external APIs (token fetch, etc.), set headers, transform inputs. Maxim gives them an `axios` / `fetch` sandbox with `maxim.getVariable()`, `maxim.getVaultVariable()`, `maxim.getEnvironmentVariable()`, etc.

```javascript
// prescript - inject auth and timestamp
function prescript(request) {
    request.headers["Authorization"] = "Bearer your-token";
    request.data = { ...JSON.parse(request.data || "{}"), timestamp: Date.now() };
    return request;
}

// postscript - reshape output
function postscriptV2(response, request) {
    return { content: response.data.message, confidence: response.data.metadata?.confidence || 1.0 };
}
```

**Environments:** Maxim has first-class **Environments** (dev/staging/prod) with keyed vault variables referenced as `{{env.key_name}}`. This lets one HTTP endpoint definition have multiple backing URLs/secrets.

**Multi-turn conversations:** Messages panel simulates user↔agent turn-by-turn, with edit/redo/replay of past messages — Maxim calls the actual endpoint per turn.

**Simulation:** Persona-driven multi-agent simulation, scenario generation. Full "what would this look like at 10k conversations/day" capability.

- **How user registers agent:** Register the agent endpoint URL in Maxim; configure payload templates and pre/post scripts. Environment per deployment.
- **Business logic preserved:** **Everything live in your agent** — tool calls, RAG, custom routes, multi-step planning, guardrails, auth, custom model selection, stateful sessions. Maxim's scripts only transform the request/response envelope; everything inside the agent runs in the user's environment.
- **What gets lost:** Internal tracing / span visibility — Maxim sees only the HTTP envelope you expose. If you want rich trace data, you instrument the agent separately with Maxim's SDK.
- **Multi-tenancy:** Yes, multiple HTTP endpoints per workspace with environments. "Multi-repository support for managing multiple applications."

**Self-positioning (Maxim's own blog):**
> "Maxim stands alone as the only platform offering HTTP endpoint-based testing, enabling teams to evaluate any agent through its API without code modifications."
> ([getmaxim.ai/articles/top-5-ai-evaluation-platforms-in-2025...](https://www.getmaxim.ai/articles/top-5-ai-evaluation-platforms-in-2025-why-api-endpoint-based-testing-matters-for-agent-development))

**Counterpoint:** Braintrust sandboxes and LangSmith Deployment also call the user's full code/agent — but with friction (Docker container / LangGraph framework requirement). Maxim's HTTP endpoint accepts literally any web service.

---

### 6. Helicone

**What gets re-executed?** **Just the LLM calls** with a *mutated* request body. Helicone's "Session Replay" cookbook (Sept 2024) iterates over captured requests for a session, lets you mutate `body.messages` programmatically (change system prompt, add instructions), and **re-issues each request to the LLM via the proxy**. Per-call mutation only. ([docs.helicone.ai/guides/cookbooks/replay-session](https://docs.helicone.ai/guides/cookbooks/replay-session), [helicone.ai/blog/replaying-llm-sessions](https://www.helicone.ai/blog/replaying-llm-sessions))

```javascript
function modifyRequestBody(request) {
    if (request.prompt_id === "assistant-response") {
        const systemMessage = request.body.messages.find((msg) => msg.role === "system");
        if (systemMessage) {
            systemMessage.content += " Take the persona of a field expert...";
        }
    }
    return request;
}
```

**Pure LLM-only.** No concept of an "agent" or "workflow" being registered.

Also notable: Helicone is **deprecating their "Experiments" product** as of Sept 1, 2025 — relying on integrations with other eval frameworks instead.

- **How user registers agent:** None. You configure the OpenAI/Anthropic/etc. SDK to use `https://oai.helicone.ai` as baseURL.
- **Business logic preserved:** Whatever was *in the prompt body* at request time. Anything requiring tool calls outside the proxy doesn't apply — the proxy only sees raw HTTP traffic to LLM providers.
- **Multi-tenancy:** N/A — this is observability at the proxy layer.
- **Summary:** Helicone is **NOT** an agent-eval platform; it's an LLM-observability platform. The gap is irrelevant to it.

---

### 7. Portkey

**What gets re-executed?** Just LLM calls — Portkey is **a gateway/proxy**, not an eval orchestrator.

> "Using Portkey Gateway, you can route your requests to different provider targets based on custom conditions you define."
> ([docs.portkey.ai/docs/product/ai-gateway/conditional-routing](https://docs.portkey.ai/docs/product/ai-gateway/conditional-routing))

Portkey's value is **config-based routing** + observability + guardrails over LLM traffic. It can route a request to different model providers based on the contents of metadata, URL path, or request parameters (e.g., "this user is on the paid plan → call the fine-tuned model"). It also recently launched an **MCP Gateway** for tool routing.

**No concept of a registered "agent" with business logic.** Portkey sees LLM calls; if your agent code lives elsewhere, it doesn't know about it. Their `batch-evals` cookbook and tracing are explicitly about LLM traffic patterns.

- **How user registers agent:** N/A. You route via Configs. Their "Agent Gateway" (2026) targets governance/observability of agents but still operates at the LLM-call level.
- **Business logic preserved:** Whatever conditional routing rules you express. Tool-calls happen *inside* the user's agent, not Portkey.
- **Multi-tenancy:** Yes — organizations, workspaces, configs. But agents aren't entities here; LLM targets and routing configs are.
- **Portkey is not in the agent-eval business.** It's infra plumbing.

---

### 8. OpenAI Evals / AgentKit

**OpenAI Evals** (the open-source framework + `evals.openai.com` registry): the model is "an eval is a structured test that compares model outputs to expected answers." Tasks evaluate a single LLM in isolation. Per their README:
> "We offer an existing registry of evals to test different dimensions of OpenAI models and the ability to write your own custom evals."
> ([github.com/openai/evals](https://github.com/openai/evals))

**AgentKit / Agents SDK / Evals 2.0** (2025+): OpenAI's recent pivot. AgentKit provides:
- A **visual drag-and-drop Agent Builder**.
- **Connector Registry** for data sources.
- **Evals 2.0**: "Run evaluations using datasets and automated grading. OpenAI claims up to 30% higher accuracy for companies using it."
- The **Responses API + Agents SDK** (March 2025) for code-based agent definitions.

**What gets re-executed?** Whatever the AgentKit workflow definition says — including tool calls, RAG, MCP, custom logic. Because the agents are *defined inside* OpenAI's system, they are by construction accessible to OpenAI's eval. This is **vendor-environment testing** (LayerLens explicitly calls out "evaluating in the vendor's environment instead of yours" as a pitfall).

- **How user registers agent:** Visual builder OR Agents SDK code pushed to OpenAI's runtime.
- **Business logic preserved:** Everything that's defined in AgentKit/Agents SDK. Anything in your own code that's not mirrored in AgentKit — including models, secrets, side-effects — is invisible to OpenAI.
- **What gets lost:** Anything *outside* OpenAI's runtime. Cross-platform comparison is awkward.
- **Multi-tenancy:** OpenAI workspace level.

---

### Honorable mention: Laminar

**The most direct competitor to the user's vision that I found.** Laminar's **Agent Rollout** feature:

> "Re-run an agent from any span in a captured trace. Change the prompt, swap the model, edit the tool call, and see what would have happened."
> ([laminar.sh/article/arize-alternative-laminar](https://laminar.sh/article/arize-alternative-laminar))

This is **the exact thing** the user is describing — replaying a production trace against the agent runtime, with surgical overrides. Laminar is Apache 2.0, OpenTelemetry-native, transcript view for long agents, SQL editor over traces, Signals for retroactive outcome tracking.

Also includes **browser-agent session replay** (e.g., for Stagehand, Playwright, Browser Use agents), which is a no-one-else-has-this feature.

Laminar's position is essentially: "LangChain's Studio + Helicone's replay + a real agent runtime debugger, OSS, single binary."

### Honorable mention: Braintrust Sandboxes (closest competitor to Maxim)

Already covered under Braintrust. User builds Docker image, pushes to Modal, Braintrust executes user's code in sandboxed compute. **Multi-environment support** (production vs staging), weights, secrets all work because the sandbox runs the user's actual environment.

### Honorable mention: Harbor

Open-source harness for sandboxed agent evals. Now integrated with LangSmith. Generally targets benchmark-style (Terminal-Bench-2.0, SWE-bench) rather than production trace replay. See [harborframework.com](https://harborframework.com).

---

## Comparison Matrix (the user's questions)

| Platform | What gets re-executed | How user registers agent | Business logic preserved | What gets lost | Multi-tenancy |
|---|---|---|---|---|---|
| **Langfuse** | Whatever user code does in `task` fn | `task=fn` OR webhook URL to user's HTTP service | Whatever `task` calls; nothing more | Langfuse can't enforce the agent is consistent — no version binding; SDK lives in user process | Project = siloed; multiple `task` fns = "multiple agents" |
| **Braintrust** | User's `Eval({task:fn})` function | Inline SDK / `bt eval --dev` HTTP / Modal sandbox / Functions serverless | Fully — sandbox runs entire Docker image with env, secrets, deps | Inline = user versioning responsibility; Functions still need explicit `invoke`; Workflows "in beta" with "agent deployment via SDK coming soon" | Project = primitive; many functions per project |
| **Phoenix** | Whatever `task` does (Span Replay = single LLM step only) | Python `task` callable; no first-class HTTP agent endpoint | Whatever task does | Span Replay is LLM-step only, NOT agent; no hosted execution in OSS Phoenix | Projects/Datasets; informal multi-agent via many experiments |
| **LangSmith** | User's `target` fn OR **LangSmith-hosted LangGraph agent** | Python `target` fn in code; `langgraph deploy` to push agent into LangSmith runtime | Fully when deployed; framework-agnostic (LangGraph, ADK, CrewAI, AutoGen, Claude SDK, Strands) | Outside LangChain stack, `target` is your job to wire; hosted execution is paid; agent version tied to deployment | Workspaces + Projects + many deployed graphs |
| **Maxim** | **The user's actual deployed HTTP endpoint** with pre/post scripts | Endpoint URL + body template + prescript/postscript JS | Everything live in user's agent — tools, RAG, multi-step, custom routes, guardrails, auth | Internal span visibility; you only ship what your endpoint returns; no hosted agent run option (user owns runtime) | Workspace, multiple endpoints per workspace, environment-per-deployment |
| **Helicone** | **Just LLM calls** with mutated body | None — proxy baseURL | Whatever was in prompt body at request time | All tool calls, business logic, state outside the proxy | N/A |
| **Portkey** | LLM calls with config-based routing | N/A — config + routing | Whatever routing rules + tool-calls happen in user code | All agent logic; Portkey is infra plumbing | Orgs, configs; not agent entities |
| **OpenAI AgentKit/Evals** | Whatever AgentKit workflow defines; Evals = single LLM | Visual builder OR Agents SDK | Whatever's defined inside OpenAI runtime | Anything outside OpenAI; vendor-environment testing | OpenAI workspace |
| **(Laminar)** | "Re-run agent from any span" — agent rollout debugger | OTEL-native SDK; Agent Rollout is the studio debugger | Whatever the trace has captured of the agent's state | Needs the agent to be re-runnable with the same env + dependencies | Apache 2.0; self-host |
| **(Braintrust Sandbox)** | User Docker image in Modal | `braintrust push` Docker image | Whole environment + secrets + deps | Sandbox timeout limits; costs of long-running agents | Project |

---

## Synthesis

### 1. The actual gap between "eval an LLM" and "eval an agent"

**Concrete examples of what's lost when you eval just the LLM:**

- **Rerankers / rewriters / query transforms** — most RAG agents rewrite the user query before retrieval. Evaluating only the final LLM call means you can't tell whether a regression came from the retrieval step, the rewrites, or the synthesizer. Each is independently evolved.
- **Multi-step planning logic** — an agent decides whether to call `search` vs `lookup_user` vs `ask_clarification`. If you eval just the final LLM response, you're blind to whether your routing heuristic changed behavior.
- **Tool-call argument formatting** — your agent's tool calls are structured JSON that must match downstream schemas. Pure-LLM eval can't catch schema regressions in tool calls; it only catches the eventual user response.
- **Custom auth, rate-limiting, retries** — your agent might retry OpenAI with backoff, fall back to Anthropic, short-circuit when a flag is on, or refuse to call tools for certain user tiers. Pure-LLM eval ignores all of this.
- **Conditional prompts** — many enterprise agents have prompts that branch on customer tier, region, or product line. The platform sees a tiny "final answer" LLM call; your real agent had a 5KB conditional system prompt.
- **Guardrails pre/post** — input guardrails (PII redaction, jailbreak detection) and output guardrails (schema validation, length caps, refusal rules). Pure-LLM eval never exercises them.
- **Stateful memory, retries-on-tool-failure, deterministic fallbacks** — production agents accumulate conversation state and back off differently from clean test conditions.
- **Multi-modal paths** — agents that sometimes return images, sometimes return text, sometimes call a code-interpreter.
- **State machines / LangGraph / stateful multi-actor setups** — the agent isn't an LLM call, it's a small program with branching.

**The category:** everything that turns an LLM call into an "agent" is exactly what's missing from LLM-only eval.

### 2. What's the right primitive for "register my agent with the platform"?

Three patterns in production today, with rough trade-offs:

| Primitive | Who offers it | Pros | Cons |
|---|---|---|---|
| **HTTP endpoint (URL + body template + prescript/postscript)** | Maxim | Framework-neutral, no SDK install, black-box, easy cross-team access, version drift lives in user's own deploy | No internal-trace visibility; latency adds hops; auth model is HTTP-only |
| **`task` / `target` callable in code (Python/JS)** | LangSmith, Braintrust, Phoenix, Langfuse | Fine-grained code control, internal tracing flows naturally | Couples eval to a code repo; needs CI infra; "agent" identity lives in the user's git history |
| **Hosted deployment of the agent runtime** | LangSmith Deployment, Braintrust Sandboxes, OpenAI AgentKit | Platform can introspect, replay, debug across the entire agent runtime | Vendor lock-in (or per-deploy auth); the platform must support the agent's framework/runtimes |
| **Container/Docker sandbox execution** | Braintrust (Modal), Harbor | Truly containerized env, deps, secrets, multi-lang | Heavy; per-run cold start; needs Docker; safety/cost concerns |

**The shape of a best-of-both-worlds primitive:**

> `register_agent(name=..., runtime=..., endpoint=..., version_policy=..., secrets=..., env="prod")`

Where `runtime` describes how to invoke (HTTP / Python / Container / "execute from this image in our sandbox"), `version_policy` makes the binding explicit (e.g., "pin to this git SHA" / "always prod" / "specific docker tag"), and `secrets` lets the platform mint auth tokens without exposing raw credentials.

**Multi-tenancy primitive:** a Project ("Acme-CC-Fraud-Department") can have many `Agent` entities (e.g., `fraud-detector-v3`, `dispute-router-canary`). Each agent has versions, environments, history of evaluations. The eval target is now *the Agent entity*, not a function in a script.

### 3. What does "call the user's agent with this trace's input" look like in practice?

**Concrete UX + API:**

```http
POST /v1/agents/{agent_id}/run
Authorization: Bearer <project_token>
Content-Type: application/json

{
  "input":         { "messages": [...the original trace input...] },
  "input_source":  "trace",                     // vs "manual" or "dataset-row"
  "trace_id":      "langfuse:abc123",           // optional: provenance
  "replay": {
    "pin_to_version":   "sha:3f0e29a",          // optional: pull THIS exact prompt
    "override_prompt":  "prompts/intro.md",     // optional: try a candidate prompt
    "override_model":   "gpt-4o-mini",
    "skip_guardrails":  false
  },
  "environment":   "staging"                    // user-registered environment
}
```

The user's agent endpoint (or hosted runtime) executes normally; the platform captures: response, latency, cost, any structured metadata returned in headers/body. This is ~Maxim's HTTP Endpoint mode today, with version-pinning and provenance added.

**For the user's agent to be replayable**, the platform needs:

1. The user to have **registered** the agent (one-time setup: URL or container, secrets, environment mapping).
2. The **input capture** from the trace to be normalized into the agent's contract (which the platform doesn't fully own — agent contracts vary).
3. **Output normalization** so scores can compare apples-to-apples between runs.
4. **Drift metadata**: a "fingerprint" of what the agent looked like when the trace was recorded (commit SHA, prompt versions, env, time).

### 4. Pitfalls

- **Agent drift since trace.** The capture was last Tuesday; today's agent is on a different prompt, has 2 more tools, calls a refactored retrieval backend, has a guardrail added. Replay tells you the agent *changed*, but not whether for the better or worse. Counter: store a **fingerprint** with each trace (code SHA + prompt version + env).
- **Stateful agents / non-idempotency.** Agents writing to a DB, sending emails, or charging a payment processor can't safely be replayed. Need a **"dry-run" mode** + replay-state isolation.
- **External side-effects during eval.** A "real" customer-support agent might call a ticketing API or a 3rd-party rate-limiter. Eval must isolate or stub these — usually by routing to a test/staging environment.
- **Authentication & secrets.** If the platform hits your agent with a captured input, it can't necessarily have your session cookies. Need: bearer token model or per-project scoped credentials.
- **RCE-style concerns.** Maxim's prescript lets you write arbitrary JS. Braintrust sandboxes execute user Docker. Any "eval platform" that hosts user code inherits the security model of a serverless platform: VPC isolation, audit logs, scoped secrets, denial-of-service rate limits.
- **Latency and concurrency.** Real agents take 5-30 seconds; 10k-row datasets × 10s = 27 hours. Need concurrency limits, sampling, resumability.
- **Comparing across versions is hard.** If you change prompts and tools, the same input has a different *meaning*. Need **paired replay** (old version vs. new version on the same input) to attribute quality deltas.
- **Reproducibility vs. live model API.** Even if your code is pinned, OpenAI's `gpt-4o` is not. Need to record model-version-as-of-trace-time and accept non-determinism.
- **Cost amplification.** Eval-on-real-agent is way more expensive than LLM-only eval. Need observability on eval costs itself.
- **Cold-start.** Container agents require time to warm up; sandbox agents require time to provision.
- **Custom state-machine replay.** Re-running a LangGraph checkpoint from span N is non-trivial — you have to rehydrate state. Some platforms punt on this entirely (the user re-runs from scratch).

### 5. Why would a user choose "eval against my real agent" over "eval against an LLM"?

**The value prop, in pitch language:**

- **Coverage.** LLM-only eval covers only the final-answer LLM. Real-agent eval covers the whole pipeline: routing, retrieval, prompts, guardrails, tools, state.
- **Regression attribution.** When a score drops, you want to know *which layer* regressed — was it retrieval precision? prompt change? tool schema shift? Guardrail? LLM-only eval collapses all of this into a single number.
- **Production parity.** Eval results predict production behavior only if eval runs the same stack. Evaluating `gpt-4o-mini` in isolation means nothing if your agent actually uses `gpt-4o` via Bedrock with custom guardrails.
- **Catches business-logic bugs.** A prompt regression, a tool-call format bug, a retrieval scope change — all invisible to LLM-only eval.
- **Better debugging.** When production traces fail, being able to replay them against a new version is the difference between debugging in the dark and full-fidelity re-running.
- **Trust for compliance.** Regulated industries (healthcare, finance) need explicit eval of the *system as shipped*, not a stripped-down version. Real-agent eval gives them an audit trail.

**When LLM-only eval is fine:** plain chatbots, content generation, simple prompt iteration, single-call applications. (But these are shrinking as the market shifts to agents.)

### 6. How big is this gap in the market?

**Currently:**

- **Maxim** owns the "call my HTTP endpoint" position. They're explicit and loud about it. Their own blog frames it as "the only platform offering HTTP endpoint-based testing." That's a marketing claim, not literally true (Braintrust sandboxes, LangSmith Deployment, Laminar agent-rollout all call user agents in some form), but it's a defensible "best-of-class" position for black-box agent testing.
- **Braintrust** is moving toward the agent-deployment model fastest (functions + sandboxes + workflow deployment).
- **LangSmith** wins the LangChain-ecosystem position with LangSmith Deployment + Studio + Harbor integration.
- **Laminar** has the most elegant OSS replayer (agent rollout debugger) but is smaller and Apache 2.0.
- **OpenAI** owns its own vendor-environment position with AgentKit + Evals 2.0.
- **Galileo, Patronus** are focused on different axes (safety / hallucination detection) and don't compete here.
- **Arize** has Phoenix for OSS and AX for commercial but their gap vis-à-vis Maxim/LangSmith is increasing.
- **Helicone / Portkey** are observability/routing infra — they're not in this race and shouldn't try to be.

**Gaps the user's platform can exploit:**

1. **"Agent is a first-class entity."** Maxim treats an HTTP endpoint as the unit of registration but doesn't show "an Agent with versions, deployments, and history" as a typed concept with UI affordances. Phoenix, Braintrust, and Langfuse are similar.
2. **"Version-pinning and drift visibility."** Few platforms let you record `code_sha + prompt_versions + env = fingerprint` per trace and replay against exactly those versions. Langfuse has versioned datasets (Feb 2026) but not for *the agent*.
3. **"Cross-tenant multi-agent registry."** Most platforms assume "one project = one agent." Most enterprises have many agents (chatbot + copilot + RAG + workflow).
4. **"Replay cost & concurrency."** No one is solving this well at scale.
5. **"Re-execution produces the same span tree."** Laminar agent-rollout is closest; the rest don't auto-compare full trace trees between baseline and candidate.

**Verdict on market gap:** not uncrowded, but **the framing "treat the real deployed agent as the eval target with full version binding + multi-tenant registry + drift detection" is under-served.** Maxim has the right primitive but a thin story on version-binding and drift. Braintrust has Function versioning but no first-class Agent entity. LangSmith Deployment is closest for LangChain. **No platform has all four pillars** (real-agent execution + version binding + multi-tenant agent registry + drift detection) tightly integrated.

This is a real, marketable gap — but not a wide one. A new entrant has a 12-18 month window before Maxim/Braintrust/LangSmith close it. The user's pitch should be specific: *"We'll replay your production traces against the exact deployed version of your agent, with one-click comparison, multi-agent registries, and drift visibility."*

---

## Sources

- Langfuse: [docs/evaluation/dataset-runs/remote-run](https://langfuse.com/docs/evaluation/dataset-runs/remote-run), [docs/evaluation/experiments/experiments-via-sdk](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk), [changelog 2025-09-17 Experiment Runner SDK](https://langfuse.com/changelog/2025-09-17-experiment-runner-sdk), [changelog 2026-02-11 versioned dataset experiments](https://langfuse.com/changelog/2026-02-11-versioned-dataset-experiments)
- Braintrust: [docs/evaluate](https://www.braintrust.dev/docs/evaluate), [docs/evaluate/remote-evals](https://www.braintrust.dev/docs/evaluate/remote-evals), [docs/deploy/functions](https://www.braintrust.dev/docs/deploy/functions), [best-practices/agents](https://www.braintrust.dev/docs/best-practices/agents), [sdks/python](https://www.braintrust.dev/docs/reference/sdks/python/0.4.3/python)
- Phoenix (Arize): [docs/phoenix/datasets-and-experiments](https://docs.arize.com/phoenix/datasets-and-experiments), [docs/phoenix/evaluation](https://docs.arize.com/phoenix/evaluation), [span-replay](https://arize.com/docs/phoenix/prompt-engineering/overview-prompts/span-replay), [what-are-traces](https://arize.com/docs/phoenix/tracing/concepts-tracing/what-are-traces)
- LangSmith: [docs/langsmith/evaluation](https://docs.smith.langchain.com/evaluation), [define-target-function](https://docs.langchain.com/langsmith/define-target-function), [deployment](https://docs.langchain.com/langsmith/deployment), [studio](https://docs.langchain.com/langsmith/studio), [run-backtests-new-project](https://docs.smith.langchain.com/langsmith/run-backtests-new-project), [reference evaluate()](https://reference.langchain.com/python/langsmith/evaluation/_runner/evaluate), [blog: Insights Agent + Multi-turn Evals](https://www.langchain.com/blog/insights-agent-multiturn-evals-langsmith)
- Maxim: [docs/offline-evals/via-ui/agents-via-http-endpoint/quickstart](https://www.getmaxim.ai/docs/offline-evals/via-ui/agents-via-http-endpoint/quickstart), [scripts](https://www.getmaxim.ai/docs/offline-evals/via-ui/agents-via-http-endpoint/scripts), [environments](https://www.getmaxim.ai/docs/offline-evals/via-ui/agents-via-http-endpoint/environments), [FAQ: evaluating agents](https://getmaxim.ai/resources/faqs/simulation-and-evaluation/how-to-evaluate-ai-agents-and-agentic-workflows), [Top 5 platforms article](https://www.getmaxim.ai/articles/top-5-ai-evaluation-platforms-in-2025-why-api-endpoint-based-testing-matters-for-agent-development)
- Helicone: [docs/guides/cookbooks/replay-session](https://docs.helicone.ai/guides/cookbooks/replay-session), [blog: replaying LLM sessions](https://www.helicone.ai/blog/replaying-llm-sessions), [features/experiments (deprecating)](https://docs.helicone.ai/features/experiments)
- Portkey: [docs/product/ai-gateway/conditional-routing](https://docs.portkey.ai/docs/product/ai-gateway/conditional-routing), [gateway GitHub](https://github.com/portkey-ai/gateway)
- OpenAI: [github.com/openai/evals](https://github.com/openai/evals), [openai.com/index/introducing-agentkit](https://openai.com/index/introducing-agentkit)
- Laminar: [article/arize-alternative-laminar](https://laminar.sh/article/arize-alternative-laminar), [blog/2026-01-29-laminar-vs-langfuse-vs-langsmith](https://laminar.sh/blog/2026-01-29-laminar-vs-langfuse-vs-langsmith-llm-observability-compared)
- Misc: [harborframework.com](https://harborframework.com), [github.com/harbor-framework/harbor](https://github.com/harbor-framework/harbor), [layerlens.ai/blog/how-to-evaluate-ai-agents](https://layerlens.ai/blog/how-to-evaluate-ai-agents), [iris-eval.com/learn/eval-drift](https://iris-eval.com/learn/eval-drift), [galileo.ai/blog/best-ai-agent-evaluation-platforms](https://galileo.ai/blog/best-ai-agent-evaluation-platforms)
