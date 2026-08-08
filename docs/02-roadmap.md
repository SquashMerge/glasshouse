# Astraea product roadmap

**Status:** Authoritative product sequencing as of `origin/main` at `4fff991`.

Astraea is an **agent-first observability and evaluation platform**. Its durable
product promise is not a generic trace dashboard or a prompt playground: teams
can turn production evidence into governed regression cases, run reproducible
evaluations, understand the result, and deliberately improve their system.

The Agent Registry remains strategic, but it is **not the next implementation
slice**. We will first make the Dataset and Evaluation foundations dependable
for real teams, with a simple user/role model and Bring Your Own Identity
Provider (BYO IdP) support. An agent is introduced only after Astraea can
reliably manage the data, evaluation definitions, access controls, and evidence
that give an agent version meaning.

## Product principles

1. **Observe → curate → evaluate → learn.** Production traces and human review
   create candidate evidence; curated datasets turn that evidence into durable
   regression cases; evaluations produce reproducible results; improvement is
   deliberate, reviewable, and never an automatic production mutation.
2. **Foundation before surface area.** A feature is not complete because a page
   or endpoint exists. It needs durable schema contracts, project isolation,
   authorization, provenance, lifecycle/recovery behavior, migration coverage,
   and trustworthy UI state before Astraea expands it.
3. **One product model across UI, API, and SDK.** A Dataset or Evaluation made
   in the dashboard is the same resource used by the API and future SDK/CI
   integrations. There are no separate “UI datasets” or hidden execution paths.
4. **Reproducibility is a product feature.** A completed run must always answer:
   *which target, Dataset version, Evaluation definition version, evaluator
   configuration, and access scope produced this result?*
5. **Humans retain control.** Feedback is evidence, not ground truth. No raw
   feedback, judge score, optimization candidate, or draft may automatically
   change a dataset, evaluation gate, prompt, model, agent, or deployment.
6. **Security and tenancy are intrinsic.** Every product record, query, event,
   and background task is bound to an authorized organization and Project.
   Client-selected IDs, browser cache, telemetry attributes, and IdP claims are
   selectors or inputs—not authorization proof.
7. **Low-friction integrations remain the destination.** When the Agent
   Registry arrives, normal adoption will be OTLP configuration or a short SDK
   registration call. Declarative manifests are an export/GitOps escape hatch,
   not a prerequisite for ordinary users.

## What is already shipped

| Capability | Status | Evidence / remaining boundary |
|---|---|---|
| Platform foundation and typed API | Shipped | PostgreSQL, ClickHouse, Valkey, Hono, React dashboard, generated OpenAPI clients, migrations, and CI quality gates. |
| OTLP ingestion and trace viewer | Shipped | Normalized GenAI/OpenInference traces, trace list/detail/search, project-scoped live updates, and trace-focused regression coverage. |
| Prompt management and optimization | Shipped | Immutable prompt versions, labels/provenance, guarded GEPA workflows, review-required outcomes, and lifecycle/SSE coverage. |
| Dataset, configured-LLM evaluation, and feedback first pass | Shipped | Project-scoped Dataset and trace/observation provenance, Experiment execution/results, benchmark runs, cancellation/recovery, and human-review workflow. |
| Project isolation and lifecycle | Shipped | Organization/Project membership, server-authorized Project selection, scoped REST/worker/SSE/telemetry behavior, governed project lifecycle, and deletion safeguards. |
| Governance | Shipped | Project-scoped policy drafts/approval, ingress redaction, safe previews, bounded retention, and content-free audit evidence. |

Shipped does **not** mean finished. The next roadmap deliberately hardens the
first-pass Dataset, Evaluation, identity, and authorization contracts before
adding Agent Registry breadth.

## Current product definition

The core Astraea loop is:

```text
Authorized user in an organization / Project
        ↓
Observe production traces and human feedback
        ↓
Curate a governed, versioned Dataset
        ↓
Publish a reusable, versioned Evaluation definition
        ↓
Resolve immutable inputs and execute an Evaluation run
        ↓
Inspect evidence, promote a deliberate improvement, repeat
```

The current configured-LLM execution path remains a supported target while the
platform matures. It lets teams prove Dataset and Evaluation behavior without
pretending that an Agent Registry already exists.

## Delivery rule for every roadmap slice

Before a slice is called complete, it must have all of the following where
applicable:

- project-scoped database, ClickHouse, API, worker, and SSE behavior;
- authorization at the server-side resource boundary, not only a hidden UI
  control;
- append-only or immutable evidence for published/versioned resources;
- explicit state transitions, cancellation/retry/recovery rules, and idempotency
  at asynchronous boundaries;
- safe redaction, retention, and content-free audit behavior;
- generated OpenAPI/client compatibility and an accessible, loading-safe UI;
- migration fresh-install and upgrade coverage;
- focused regression tests plus the repository's format, lint, typecheck, build,
  test, security, migration, and browser/CI gates.

A release may improve ergonomics in parallel, but it must not make a roadmap
feature look complete while bypassing these conditions.

---

## The execution sequence

### Release hygiene — maintain the shipped baseline

Land and validate narrowly scoped defect/security/UX fixes that protect the
existing loop. These do not reorder the roadmap, but are release blockers when
they affect data integrity, disclosure, tenant boundaries, lifecycle recovery,
or accessibility.

Current ready maintenance work should be handled independently from the larger
feature tracks; it must not be bundled into the next foundational PR merely for
convenience.

### P1 — Identity, roles, and BYO IdP foundation

**Goal:** make Astraea usable by real organizations without overbuilding an RBAC
platform, while preserving the existing server-authorized organization/Project
boundary.

#### Target access model

Astraea will standardize on three understandable roles:

| Role | Scope and intended capability |
|---|---|
| **Admin** | Organization administrator. Manages organization settings, users/role assignments, Project access, identity-provider connections, governed/destructive controls, and all Projects in the organization. At least one active Admin must always remain. |
| **User** | Normal contributor. Accesses only Projects granted to them; can perform ordinary product work permitted in those Projects, such as curating datasets, creating Evaluation drafts/runs, and participating in review. Cannot manage organization security, users, IdP connections, or protected/governed controls. |
| **Read-only** | Viewer. Accesses only granted Projects and may inspect allowed traces, Datasets, Evaluations, runs, and audit-safe history. Cannot create, modify, execute, approve, promote, delete, or change membership/security state. |

Organization role establishes administrative authority; Project membership is the
visibility boundary. An Admin is authorized across the organization. User and
Read-only access is granted per Project. This avoids a misleading “user can see
the whole organization” default while keeping the product model simple.

The current `owner` / `manager` / `member` implementation is a compatibility
baseline. P1 defines an explicit, tested migration to the target vocabulary and
permissions; it must not silently widen anyone's access. A temporary
server-side compatibility mapping is acceptable only while every response,
policy check, audit record, and UI explains the effective target role.

#### BYO IdP / SSO contract

Astraea will support organization-configured SSO, beginning with standard
**OpenID Connect (OIDC) Authorization Code + PKCE** and a durable provider
connection model that also accommodates **SAML 2.0** connections. The goal is
customers using their own identity provider—not an Astraea-hosted directory.

Required behavior:

- authenticate an external subject into a stable internal actor identity;
  do not use mutable email alone as identity;
- bind each IdP connection to exactly one organization and validate issuer,
  audience/client, redirect URI, signature/key rotation, nonce, state, PKCE,
  and session lifetime;
- map users to Astraea roles and Project memberships through an explicit,
  auditable administrator-controlled mapping. An IdP group/claim is never an
  authorization decision until it is mapped and validated server-side;
- support a safe bootstrap and break-glass Admin path during rollout, and never
  let a malformed IdP connection lock an organization out of Astraea;
- make SSO enforcement an explicit organization setting after connection testing
  and administrator confirmation, not an implicit behavior change;
- record content-free audit evidence for provider changes, login/link events,
  role/membership changes, connection testing, and enforcement changes;
- preserve the same actor/organization/Project authorization checks for REST,
  Web, OTLP ingestion credentials, SSE, workers, and recovery paths.

**Not in P1:** SCIM provisioning, just-in-time role escalation, social login,
custom policy expressions, nested teams, or a broad marketplace of identity
connectors. SCIM may follow once the stable User, membership, provider, and
audit contract has real production use.

#### P1 exit criteria

- Admin/User/Read-only permissions are enforced at API, database, UI, SSE, and
  worker boundaries and are covered by a role × Project × resource test matrix.
- An organization has a recoverable administrator path and cannot lose its last
  active Admin through normal APIs or IdP synchronization.
- An OIDC organization connection is configured, tested, enabled, and disabled
  safely; its identity/role/membership mapping cannot leak or cross tenant
  boundaries.
- SAML support uses the same actor and authorization model rather than a
  parallel login/membership implementation.
- Existing Basic Auth deployments migrate safely and remain explicitly supported
  only as the documented compatibility/bootstrap mechanism until an operator
  enables SSO enforcement.

### P2 — Dataset lifecycle: durable regression assets

**Goal:** evolve the shipped first-pass Dataset into the trustworthy shared
asset at the center of the feedback loop.

#### Scope

1. **Stable Dataset identity.** Project-local slug, editable display metadata,
   tombstoned identity on deletion/archive, and explicit ownership/audit fields.
2. **Drafts and immutable published versions.** Editing happens in a draft;
   publishing atomically validates, snapshots, hashes, allocates a version, and
   records provenance. Published versions cannot be mutated.
3. **Dataset-item provenance and revision.** Preserve source trace and
   observation IDs, sanitized capture context, external source identity, stable
   item keys, ordered snapshots, and curator/audit metadata. Never turn raw
   trace output or feedback into unreviewed ground truth.
4. **Schema and validation.** Explicit input, optional expected-output, and
   metadata contracts; clear row-level errors; deterministic validation before
   publish or execution.
5. **Collaborative safety.** Revision/ETag conflict behavior, idempotent
   publish/import, intentional archive/delete semantics, and safe handling of
   items referenced by historical runs.
6. **First-class dashboard/API parity.** Create/import/edit/curate/publish/diff
   flows work through the same API for UI, API, and eventual SDK callers.

#### P2 non-goals

Do not add bulk automation that changes a published Dataset without a human
publication decision. Do not make semantic clustering, model-generated labels,
training exports, or automatic prompt/agent updates a prerequisite for a strong
Dataset foundation.

#### P2 exit criteria

- A production trace can become a redacted, reviewable Dataset draft item with
  preserved provenance, then an immutable published version.
- Historical Evaluation runs remain explainable after later Dataset edits,
  archival, or new publication.
- UI/API/SDK-created changes share the same draft/version/validation/audit
  contract and Project authorization checks.
- Dataset-version integrity, conflict, publish/retry, cross-Project access,
  and retention/deletion behavior have deterministic regression coverage.

### P3 — Evaluation definitions and reproducible execution

**Goal:** turn one-off Experiments into reliable, reusable Evaluation
Definitions and Runs while continuing to use the current configured-LLM target
where appropriate.

#### Scope

1. **Separate definition from run.** An Evaluation is a stable named resource;
   an immutable Evaluation Definition version contains Dataset binding,
   evaluator settings/mappings, execution defaults, thresholds, and target
   selector; an Evaluation Run is one resolved execution.
2. **Atomic resolution.** Before queueing, resolve and persist the exact
   Evaluation Definition version, Dataset version, target configuration,
   evaluator versions/settings, deterministic sample, Project, actor, and safe
   trigger metadata. A queued run never reads a mutable draft.
3. **Execution integrity.** Define cancellation, retry, lease/recovery,
   concurrency, idempotency, item-level state, trace linkage, SSE lifecycle,
   and result retention semantics before expanding evaluator breadth.
4. **Evaluation evidence.** Show run summary, per-item evidence, source
   Dataset/provenance, evaluation-emitted trace, score rationale, and explicit
   run comparison. Failure results remain inspectable rather than being reduced
   to a single opaque percentage.
5. **Narrow evaluator growth.** Keep deterministic evaluators and clearly
   bounded configured-LLM evaluation reliable first. Add each richer evaluator
   only with typed config, cost/time limits, redaction, reproducibility, and
   calibration/evidence requirements.
6. **Approval-aware gates.** A release/CI gate may consume a pinned,
   administrator-approved Evaluation Definition version only after the access,
   dataset, and execution contracts above are complete.

#### P3 non-goals

No evaluator marketplace, arbitrary uploaded code, broad multi-judge scoring,
or automatic production action before baseline definitions and runs are
trustworthy. Schedules and CI gates follow pinned definitions; they do not
follow mutable “latest” data by accident.

#### P3 exit criteria

- A team can create a Dataset version and Evaluation Definition version in the
  UI or API, execute it, inspect immutable evidence, and reproduce the run.
- A run records non-null resolved Dataset and Evaluation Definition versions;
  no mutable draft can influence an in-flight or completed result.
- State/retry/cancellation/recovery, Project/role isolation, SSE, and
  configured-LLM error paths are verified with deterministic tests and real
  integration coverage where infrastructure is available.
- A comparison or gate clearly identifies its pinned evidence and rejects
  unauthorized or unapproved use.

### P4 — Agent Registry and version-bound targets

**Goal:** introduce Agents only when Astraea has reliable data, evaluation,
identity, and execution foundations to make a first-class Agent useful.

The Agent Registry remains the differentiated strategic primitive, but it ships
as a **narrow identity/version contract**, not a framework-integration flood:

- project-scoped stable Agent identity and immutable manifest versions;
- canonical manifest serialization and content-hash idempotency;
- source/framework/version metadata and safe manifest summaries;
- explicit, role-authorized version history and diffing;
- Evaluation Runs pinned to a resolved Agent/manifest version;
- a generic/HTTP target or one carefully selected SDK path only after its
  execution boundary is hardened.

Normal onboarding stays low-friction: OTLP configuration and SDK
`register(agent)`/introspection are preferred; agent manifests are generated
artifacts for export, audit, or GitOps—not user-authored YAML required at setup.

### P5 — Integrations, GitOps, and organizational automation

After P4 proves useful with production users:

- additional framework adapters and HTTP endpoint registration;
- version comparison, environment binding, and drift detection;
- protected environment promotion and organization-approved CI gates;
- a GitHub Action and API/SDK ergonomics built on pinned Evaluation definitions;
- SCIM provisioning if P1's identity/membership operations show that manual
  administration is the real scaling bottleneck.

### P6 — Intelligence and scale

Only after the evidence loop is reliable:

- evaluator library growth, LLM-as-judge calibration, and transparent scoring;
- failure discovery/clustering and regression-candidate workflows;
- closed-loop optimization proposals with explicit human review/promotion;
- voice-agent support, broader enterprise controls, and packaging/release
  polish driven by demonstrated user demand.

---

## Explicit sequencing decisions

| Decision | Why |
|---|---|
| Build identity/roles/SSO before expanding Dataset/Evaluation collaboration. | Shared curation, governance, and future release gates require accountable users and enforceable authority. |
| Build Dataset versions before reusable Evaluation definitions. | An Evaluation cannot be reproducible if its source suite remains mutable. |
| Build Evaluation Definitions/Runs before Agent Registry. | Astraea needs a dependable place to bind and evaluate a future Agent version; configured-LLM targets let us prove the execution model now. |
| Introduce Agents before framework breadth. | A small immutable Agent identity/version contract is more valuable than many shallow adapters. |
| Add SCIM, complex RBAC, and broad IdP catalogs later. | The three-role, Project-scoped model must prove secure and usable before automating administration. |
| Defer automatic dataset/prompt/model/deployment changes. | Astraea should make evidence and decisions stronger before it automates consequential changes. |

## Measures that tell us the roadmap is working

- A Read-only user cannot mutate or execute anything, even through a direct API
  call or stale browser state.
- A User can turn a production failure into a reviewed Dataset version without
  needing an administrator or an engineer-only path.
- An Admin can connect their IdP, map access safely, test it, and recover from a
  bad configuration without tenant leakage or lockout.
- Any completed Evaluation Run can be reproduced and explained from stored,
  immutable references.
- A customer can adopt Astraea's future Agent integration without rewriting an
  existing framework agent or hand-authoring a manifest.

## Deferred intentionally

The following remain strategically valuable but are **not** prerequisites for
P1–P4: broad framework coverage, generic custom-code evaluators, evaluator
marketplaces, semantic feedback clustering, automatic prompt/model changes,
SCIM, custom role builders, enterprise billing, GitHub Actions, manifest drift
detection, and voice support.

Deferral is a focus decision—not abandonment. Each deferred area must consume
the access, Dataset, Evaluation, and Agent-version contracts established above
rather than creating a parallel model.
