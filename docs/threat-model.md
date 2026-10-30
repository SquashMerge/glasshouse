# Glasshouse threat model

**Status:** Living security design baseline; not a certification, penetration-test report, or guarantee that every control is correctly implemented.

**Baseline reviewed:** `main` at `6d1d3060d46b379bd45745a7c123c3d030fed6ab` (2026-10-06). Revalidate implementation claims against the exact branch/commit under review; update this model when architecture, data flows, identity, deployment, or security controls materially change.

## How agents must use this document

Use this model to identify relevant attacker goals, trust boundaries, assets, and residual risks when reviewing or changing Glasshouse. It is a map for analysis, not authorization to assume that a control works. Verify each relied-upon control in current code, schema/migrations, configuration, and tests. Treat documented-but-unverified behavior as an assumption, not proof. If the implementation differs, report the discrepancy and update this document in the same change when the model is affected.

For a security-sensitive change:

1. Trace the public route or worker entry point through authentication, authorization, validation, persistence, asynchronous effects, and response/event delivery.
2. Treat every client-supplied ID, role, organization, Project, telemetry attribute, prompt, dataset row, model output, and event as untrusted until validated at the server-side boundary.
3. Check REST, OTLP, SSE, worker dispatch, retries, cancellation, restart recovery, and migration paths where the feature touches them. A UI restriction or request-admission check alone is not an authorization control.
4. Add or update a regression at the boundary that prevents the harmful effect; do not use this document as a substitute for tests, code review, or deployment review.
5. State which threats are mitigated, deployment-dependent, residual, or out of scope. Do not describe roadmap items as shipped or infer a security guarantee from a test name.

## System and scope

Glasshouse is a self-hosted observability and evaluation platform. The shipped system includes a React/Vite web application, a TypeScript/Hono API, PostgreSQL transactional state, ClickHouse trace/evidence data, Valkey coordination/pub-sub, and asynchronous evaluation/optimization work. The API can send evaluation or optimization inputs to configured LLM providers. The optional GEPA Python worker is a child process of the API. Operators deploy the application and its dependencies; deployment topology, TLS, network policy, backups, and secret delivery are operator-controlled.

In scope: confidentiality, integrity, and availability of authentication material, organization/Project data, telemetry, prompts, datasets, evaluation evidence, governance decisions, provider credentials, and deployment configuration; tenant isolation; authorization and revocation; data egress; abuse of public/authenticated interfaces; and the software delivery path.

Not shipped and therefore not assumed protected by this model: SSO/OIDC/SAML, SCIM, a production Agent Registry or manifest-bound real-agent execution, SDK/CI agent execution, and drift detection. The current Agent Introspection contract is explicitly client-reported supplemental evidence, not proof of execution. See [the roadmap](02-roadmap.md) and [the introspection contract](agent-introspection-contract.md).

## Security objectives and assets

- Keep organizations and Projects isolated across reads, writes, search, exports, OTLP ingestion, events, worker work, and recovery.
- Allow only currently authorized actors to use product data or perform governed, destructive, administrative, and recovery actions; revoke future effects when authority is removed.
- Protect passwords, one-time setup/enrollment tokens, session cookies/CSRF values, Basic credentials, Project-scoped OTLP bearer credentials, database/cache credentials, and model-provider keys from unauthorized disclosure, logs, audits, URLs, browser storage, and untrusted reports. Session and CSRF values may be delivered to the intended authenticated browser client for protocol use; protect them from other clients and unintended recipients. Enrollment codes are intentionally returned once to an authorized provisioning/reset caller; never disclose them outside that one-time handoff or in lists, logs, audits, or URLs. Project-scoped OTLP secrets are returned only at create/rotate time, persisted as a one-way digest, and accepted only for trace ingestion.
- Preserve the confidentiality and integrity of prompts, trace input/output, dataset examples, feedback, evaluation definitions/results, and audit/provenance records.
- Bound resource use and make asynchronous work, destructive operations, and failures recoverable without unsafe replay or cross-tenant effects.
- Make security-sensitive behavior reviewable through typed contracts, migrations, safe audit evidence, and reproducible tests.

## Actors and trust boundaries

| Actor/component | Trust and authority |
|---|---|
| Anonymous network client | Untrusted. Can reach only explicitly public method/path operations; may send malformed, oversized, replayed, or abusive traffic. |
| Authenticated Admin, User, or Read-only actor | Authenticated but not universally trusted. Authority is role- and operation-dependent; a valid identity does not authorize another Organization or arbitrary Project. |
| Organization/Project administrator | May manage defined resources in their own scope. An administrator account compromise can expose or alter that scope; it does not justify trusting client-supplied scope elsewhere. |
| Operator/deployment administrator | Controls runtime secrets, bootstrap/recovery configuration, network exposure, TLS/proxy, database access, backups, and application images. This is a high-trust boundary; compromise can defeat application controls. |
| Browser ↔ edge/API | Browser input, cookies, headers, origins, cached state, and displayed telemetry cross a network boundary. Production must use one configured HTTPS origin; proxy behavior is part of the security boundary. |
| API ↔ PostgreSQL / ClickHouse / Valkey | Service credentials and network access are trusted infrastructure. Database constraints and scoped predicates are defense-in-depth; a database/service compromise is outside ordinary request authorization. |
| API ↔ GEPA worker / configured LLM provider | Inputs and outputs can contain sensitive prompt/dataset material. The provider is an external recipient. The worker is a subprocess, not a separately sandboxed security domain. |
| Repository/CI/dependencies ↔ release/deployment | PR content and third-party packages are untrusted inputs to the build/review process. Deployment credentials or Docker access materially increase impact. |

## Principal attack scenarios

### A. Cross-tenant or cross-Project access (high impact)

**Attacker:** authenticated actor or malicious client controlling request IDs, query/body selectors, OTLP headers/attributes, cursors, or stale browser state.

**Goal:** read, write, stream, ingest into, export, mutate, or cause work in another tenant's data.

**Expected control:** authentication establishes a trusted actor and Organization; a supplied `project_id` is only a resource selector. The API must authorize the operation against that actor and active Project, and bind both scopes in database/ClickHouse operations. Persisted tenant keys/FKs and authorization checks on worker/recovery/SSE paths reinforce this boundary. Cursor scope must be validated wherever cursors are used; any future cache must include the complete tenant/Project identity in its key and invalidation contract. OTLP payload metadata must not establish scope. Project-scoped OTLP bearer credentials derive organization and Project from the stored credential, are accepted only for `POST /v1/otel/v1/traces`, and must reject a missing or mismatched Project header; their management requires an organization Admin. See [authorization contract](07-project-workspace-authorization.md), [runbook](08-project-workspace-authorization-runbook.md), `apps/api/src/middleware/auth.ts`, `apps/api/src/tenancy.ts`, and `AGENTS.md`.

**Review focus:** IDOR through any route or alternate method; missing/ambiguous Project selectors; SQL predicates and composite references; cache/cursor/SSE leakage after switching Projects; archived/deleting Project behavior; stale or unscoped historical rows; and background actions that outlive the initiating request. Never infer tenant authority from UI visibility or a UUID's unguessability.

**Organization usage aggregate exception:** `GET /v1/organization/usage` is intentionally available to every authenticated organization member, including Read-only actors, and exposes only Project identity/lifecycle metadata and aggregate retained-row counts. It must derive the organization from trusted authentication context, recheck active organization membership, enumerate only that organization's active/archived Projects, and filter both ClickHouse tables by the same organization and those Project IDs. It must not return payload columns or imply access to detail/query/export routes. This deliberately reveals organization-wide aggregate activity to every member; do not generalize the exception to other Project surfaces. Dependency health is a separate service-availability signal, not evidence of telemetry ingestion.

### B. Revocation races in requests, streams, and background work (high impact)

**Attacker/event:** a valid actor's role, session, credential, or Project is revoked while a request, SSE stream, queued job, retry, or recovery is active.

**Goal:** continue reading, dispatching provider calls, or persisting results after access is revoked; duplicate uncertain external work.

**Expected control:** short-lived credential/membership/Project fences and a documented lock order serialize relevant decisions. SSE revalidates each frame through delivery; workers recheck durable requester authority at admission and before effects. Durable effect claims prevent blindly replaying provider/trace work whose remote result is unknown. These are logical coordination controls, not a distributed transaction: a provider or ClickHouse effect whose claim committed before revocation may already have happened and cannot be undone. See `docs/08-project-workspace-authorization-runbook.md` and `apps/api/src/lib/authorized-sse.ts`, `apps/api/src/lib/execution-admission.ts`.

**Review focus:** prove interleavings with real storage-backed tests where required; check every emitted frame and every persistence/provider effect, not just initial admission. Do not hold database authorization locks across provider calls. Do not claim revocation can undo an already-dispatched external action.

### C. Credential theft, brute force, CSRF, and account recovery (high impact)

**Attacker:** remote login attacker, malicious cross-site page, compromised browser/device, or someone with access to deployment secrets.

**Goal:** take over an account, replay a session/enrollment/bootstrap secret, forge a cookie-authenticated mutation, enumerate accounts, or abuse recovery.

**Expected control:** local password hashes use Argon2id; sessions are random opaque 32-byte values stored as digests with an eight-hour absolute lifetime, revocation, `HttpOnly`/`SameSite=Strict` cookies, `Secure` in production, Origin/Fetch-Metadata checks, and CSRF tokens for unsafe cookie requests. Login errors are non-enumerating and verification is rate/concurrency bounded. Admin-issued enrollment/reset codes are high-entropy, single-use, expiring, stored by digest, and not returned in list/audit responses. The first-Admin setup token is supplied by the operator: provisioning validates canonical encoding and stores only its digest, but does not measure entropy. Operators must provision it as a 32-byte CSPRNG token encoded as unpadded base64url, as specified in the [credential runbook](local-credentials-runbook.md). Cookie presence takes precedence over Basic; an invalid cookie must not fall back to Basic. Break-glass is operator-configured and audited. See [session runbook](local-sessions-runbook.md), [credential runbook](local-credentials-runbook.md), and [account management](local-account-management.md).

All local password operations, including login and current-password verification, require at least 12 Unicode code points and at most 1024 UTF-8 bytes. Shorter stored passwords are intentionally unsupported; the same validator gates hashing and verification.

**Residual/deployment considerations:** Basic Auth remains an API/operator compatibility mechanism. SSO/MFA are not shipped. HTTPS, exact public-origin configuration, proxy header/body logging exclusions, secret storage/rotation, and edge rate limiting are deployment responsibilities. Do not put secrets in URLs, logs, issue text, screenshots, browser storage, or command output.

The OTLP credential page keeps revealed secrets in component state, while shared query/mutation caches retain only credential metadata. Dismissal, replacement, and revocation clear the revealed secret; Project/authority changes and unmount invalidate pending reveals. Reveal eligibility is captured at submission, before an offline mutation can pause, so returning to the original Project cannot reauthorize its stale reveal on reconnect. This limits application retention, not access by someone controlling the browser or copies explicitly placed on the clipboard. Credential management requires current organization Admin authority, not creator identity. Bearer ingestion uses the creator Actor's current authority and enabled-account state, so an unrevoked credential marked Active can still be unusable. See [OTLP authentication](03-otel-ingest.md#authentication).

On protected-page focus, the browser starts a fresh session request and fences older in-flight session responses, including when cross-tab storage invalidation is unavailable. It resets mounted query observers and refetches active queries, including `/v1/me`, so cached query results and prior role/capability flags are absent during refresh. To keep components whose routes remain mounted from losing local form state, the provider retains only the last selected Project as a non-authoritative read-only shell, with management/governance capabilities disabled; if `/v1/me` fails, organization authority remains unavailable and project capability remains least-privileged. The NewPromptPage composer has regression coverage. EditPromptPage retains a source snapshot scoped to its Project, prompt slug, and source version during a same-context query reset so the composer stays mounted; a changed Project, slug, or source version remounts the composer and discards its local draft. An error or authority failure still removes the editor rather than retaining private content. The complete protected subtree is immediately visually/accessibility-hidden and inert behind an opaque full-viewport modal in the browser's top layer, covering and inactivating portaled UI as well. Only the newest check may reveal content once its session request and active-query refresh both finish. Same-identity drafts reappear unchanged only in components that stayed mounted; a changed Actor, Organization, authentication kind, or username remounts the protected subtree while hidden to discard private drafts. The cached session expiry remains enforced during pending checks; invalid sessions clear workspace state and unavailable checks unmount protected content. Focus and storage events are browser freshness controls, not continuous revocation or a substitute for server-side authorization.

### D. Sensitive telemetry, prompts, datasets, and model-provider disclosure (high impact)

**Attacker/event:** malicious or compromised instrumented agent, authorized user submitting sensitive examples, misconfigured redaction, or an external model provider receiving an evaluation/optimization request.

**Goal:** persist or disclose credentials, PII, prompts, tool results, feedback, or customer data beyond its intended scope; poison evidence or manipulate evaluation outcomes.

**Expected control:** OTLP payloads are bounded and normalized; tenant scope comes from authentication plus an authorized Project selector, not payload attributes. Optional server-side redaction applies before new ingestion persistence and governance policy can add stricter redaction. Trace text/metadata and events have size limits; audit records are designed to be content-free. Governance/retention currently covers only documented resource classes; it is not universal deletion. See [OTLP guide](03-otel-ingest.md), [governance runbook](09-governance-runbook.md), and `apps/api/src/db/redact.ts`.

**Residual:** redaction defaults off unless configured; redaction is not retroactive and cannot reliably identify every secret. Trace input/output, dataset examples, prompts, and model outputs may be sensitive. Evaluation/optimization can send configured input to a third-party LLM; treat that provider and configured endpoint as data recipients. Verify model/provider, endpoint, retention terms, and data approval before sending sensitive content. Prompt injection in a trace or dataset is untrusted content and can influence model output/score; never treat model output as authorization, code, or a trusted release decision. Review dataset curation, output handling, retention scope, and provider egress in every relevant change.

### E. Ingestion, expensive work, and availability abuse (medium/high impact)

**Attacker:** anonymous or authenticated client flooding login, health, OTLP, search, run creation, SSE, or expensive LLM/GEPA paths.

**Goal:** exhaust CPU, memory, database/ClickHouse connections, storage, provider quota, or concurrency; create duplicate work or unbounded event queues.

**Expected control:** API body-size and route-level structural bounds, bounded model-call/sample/concurrency budgets, worker output/diagnostic limits, bounded SSE frames/bytes/timeouts, and idempotent/recovery rules reduce selected paths. Login verification also has bounded admission. These limits do not by themselves prove system-wide rate limiting or capacity safety.

GEPA job creation enforces separate active-job caps per Project and per durable requester Actor across all Projects. A transaction-scoped, requester-namespaced advisory lock keyed by the trusted authorization Actor UUID follows authorization/Project locks and precedes counting/insertion; admission acquires no further Project locks while holding it. Counts join each job to its Project's Organization and resolve stored `requested_by` provenance with `trusted_actor_subject_matches`, so equivalent Basic username spellings share capacity while their original provenance remains intact. Active-job replay precedes capacity checks. This bounds job admission, not provider-side resource consumption after dispatch.

**Residual:** operators must configure ingress/network rate limits, capacity, monitoring, quotas, disk limits, and backups. Health and other documented public operations can still be availability targets. Test worst-case bounded paths and cancellation/recovery when changing these controls.

### F. Provider configuration and worker execution boundary (high impact)

Provider credentials are configured by the operator, not the caller. The current OpenAI-compatible client sends the API key to the configured base URL; changing `OPENAI_API_BASE` therefore changes the credential recipient. Restrict that setting to an explicitly trusted HTTPS endpoint and do not let request or dataset content select it. Provider responses are untrusted input and must be bounded/validated before persistence or user display.

The development CLI provider introduces a separate command-execution boundary. `GLASSHOUSE_DEV_LLM_COMMAND` is parsed as a JSON argv array and spawned by the API; the child receives the API process environment and prompt input. Keep the command and executable operator-controlled, never derive them from request/dataset content, and assume the child can read every inherited secret. This provider is blocked in production, and the production validator rejects `GLASSHOUSE_ALLOW_DEV_LLM_IN_PRODUCTION=true`; the setting remains a local-development-only compatibility control, not a sandbox. Separately constrain the command, environment, filesystem, and network egress in development.

The optional GEPA worker receives a structured request over stdin and has bounded/validated output and filtered diagnostics, but the API spawns it with inherited environment variables. It is not an OS/container sandbox and may have access to the API process's provider credentials. Do not run untrusted worker code/configuration in production or claim isolation based only on the JSON protocol. See `apps/api/src/lib/gepa-worker.ts`, `worker/gepa_worker.py`, `apps/api/src/lib/llm.ts`, and `docs/02-roadmap.md`.

### G. Supply chain, CI, and deployment compromise (high impact)

**Attacker:** malicious PR/dependency, compromised action/package/repository credential, unsafe self-hosted runner, or operator/deployment host compromise.

**Goal:** execute code in CI/deployment, inject a backdoor, steal secrets, or replace the running application.

**Current measures:** lockfile-based installs (including hash-verified Python worker installs in app images and devcontainer setup), pinned GitHub Actions by commit, a dependency-release-age verifier that structurally parses merge-base/target Bun JSONC lockfile blobs from a trusted-base workflow without executing PR code, a Trivy filesystem vulnerability/secret scan, and workflow permissions that are read-only where declared. The verifier compares npm package identities/versions independent of formatting and rejects unsupported lockfile structures/sources. The root `.dockerignore` excludes local environment/credential files, backups/dumps, Git/tool state, dependencies, virtual environments, and generated artifacts from both app build contexts while retaining required sources and migration inputs. These filters govern new builds, not existing registry images, and cannot identify arbitrarily named secret files. The repository notes that the dependency-age workflow is advisory rather than an enforced required check on GitHub Free; verify the exact PR checks and branch rules rather than assuming it gates merge.

**Residual:** a compromised maintainer account, dependency, CI action, host, secret store, or Docker daemon can exceed application-level controls. Base/database image tags remain mutable; final-image scanning/signing/provenance verification is not configured here. These are assurance gaps, not proof of an exploitable vulnerability. Review workflow trigger/permissions changes, action pinning, package updates, provenance, and deployment runner authority. The development Compose file is not a production security boundary; inspect the actual deployment override, ports, proxy, TLS, secret mounts, network, backup, and restore process for each deployment.

### H. Destructive actions and evidence integrity (high impact)

**Attacker:** authorized but malicious/compromised actor, stale approval, concurrent lifecycle request, or unsafe recovery/retry.

**Goal:** delete or alter evidence, bypass governance approval, publish an unintended prompt/dataset version, remove the final Admin, or misrepresent an evaluation.

**Expected control:** server-side operation roles, immutable/versioned records, ETags/optimistic concurrency where applicable, approved governance policies and single-use previews, durable audit/lifecycle records, last-Admin safeguards, and bounded recovery are documented. Every newly created Project receives a system-created and system-approved baseline policy (30-day trace retention, 90-day dataset and feedback retention, and redaction mode `none`) without human review. This is an automatic provisioning default, not a human governance approval; subsequent policy versions still require Project Admin approval. Feedback and judge scores are evidence, not ground truth; normal workflow does not automatically promote them. The intentionally narrow GEPA system-prompt path has its own held-out validation, leakage, and source-version guards. See [roadmap](02-roadmap.md), [governance runbook](09-governance-runbook.md), and [dataset feedback design](06-dataset-feedback-future.md).

**Review focus:** check direct API calls as well as UI flows; preserve approval/version semantics; ensure destructive actions are scoped, auditable, bounded, and replay-safe; inspect each data store's actual retention/deletion coverage. A documented retention run is not proof that every resource class is deleted.

## Production deployment path

The supported single-host production topology is `infra/compose.production.yaml`
with an operator-managed HTTPS reverse proxy in front of loopback-bound API and
web ports. PostgreSQL, ClickHouse, and Valkey have no host port bindings in
that file. The API rejects non-production `NODE_ENV`, non-HTTPS public origins,
weak required secrets, the development GEPA CLI mode, and the explicit
development LLM override at startup. These are configuration controls, not a
replacement for host firewalling, proxy hardening, secret management, or
backup/restore testing. The local `make dev` Compose path remains development-
only and is not a production security boundary.

Production Compose explicitly maps the required Valkey password, deployment
redaction floor, and Evaluation model/budget envelope into the API environment;
an interpolation `--env-file` alone does not inject service environment variables.
The local environment-normalization helper writes a private same-directory
temporary file, preserves owner restrictions while removing group/world access,
atomically replaces the original, rejects symlinks, and cleans up on errors and
catchable termination signals. Trace reset sends ClickHouse client credentials
over stdin into a private container configuration file, removes it on normal/error
unwinding, and suppresses raw client diagnostics. Host/container administrators
can still inspect secrets, and forced termination or loss of container access can
prevent cleanup; these are operational secret-handling controls, not sandboxing.

## Important assumptions and non-guarantees

Datastore major-version migration uses a quiesced source backup and a separate
empty target with inspected non-overlapping mounts; source volumes are retained
for rollback. PostgreSQL restore is fail-fast and single-transaction, but there
is no atomic restore across PostgreSQL and ClickHouse. A partial restore needs
another empty target. CI's historical logical-restore fixture does not prove
arbitrary custom-schema compatibility or an in-place volume upgrade. See
[datastore upgrades](datastore-upgrades.md) and [backup/restore](backup-restore.md).

- This is a self-hosted application; operators control TLS termination, firewall/network reachability, runtime secrets, database access, backup/restore, and host security. Do not assume the repository's development Compose defaults are safe production settings.
- Control descriptions above are implementation claims at the stated baseline, not independent audit results. Verify changed or security-critical paths against code, migrations, configuration, and tests on the exact reviewed revision.
- PostgreSQL, ClickHouse, Valkey, the host, and configured external providers are trusted infrastructure boundaries. This document does not model compromise of their administrators as an application-level adversary the app can fully contain.
- There is no guarantee of zero data loss, permanent deduplication, undo of an already-sent provider request, complete automatic redaction, or universal retention/deletion across all stores.
- No formal STRIDE/attack-tree exercise, external penetration test, compliance audit, or assurance of all dependencies is implied by this file.

## Change triggers for this model

Revisit this document whenever a change adds or modifies: identity/session/provider authentication; organization/Project roles or tenant-bearing data; a route, export, event stream, worker, retry/recovery path, or external egress; prompt/dataset/evaluation handling; redaction/retention/deletion; secrets; database/ClickHouse/Valkey topology; public ports/proxy/TLS; or CI/deployment permissions and dependencies. Keep current controls, assumptions, residual risks, and future capabilities clearly distinguished.
