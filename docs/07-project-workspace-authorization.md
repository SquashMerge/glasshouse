# Project workspace authorization contract

**Implementation contract for [#51](https://github.com/dsarlo/astraea/issues/51), [#59](https://github.com/SquashMerge/glasshouse/issues/59), and [#98](https://github.com/dsarlo/astraea/issues/98)**

## Purpose

Establish the smallest durable, server-enforced organization actor and Project
membership boundary that lets Glasshouse safely isolate all product data by the
selected Project. This is a prerequisite for #49 governance and #50 Agent
Registry work.

A browser-selected `project_id` is a resource target only. It never creates
organization identity or authorization: the server derives the actor and
organization from the trusted authentication result and validates access before
any read, write, query, event subscription, or background recovery action.

## Existing baseline

The compatibility baseline used Basic Auth with legacy `owner/member`
organization roles and `manager/member` Project roles. Durable actors bind a
verified credential to one organization; a browser-selected `project_id` remains
only a resource target. The Admin/User/Read-only policy below is enforced by the
same server-side decision for REST, SSE, OTLP, product work, and lifecycle paths.

## Binding policy decisions

These decisions resolve the original Factory story gate and are part of the
implementation contract.

1. **Basic Auth identity:** each configured Basic Auth credential has a unique,
   normalized provider subject and organization-scoped durable actor identity.
   Authorization resolves legacy membership subjects through that verified
   identity, so case/NFKC-equivalent configured usernames remain continuous
   without trusting a client value. A credential cannot select another
   organization; ambiguous, malformed, or orphaned legacy identities fail
   closed. A later identity provider maps into this durable boundary rather
   than changing product ownership.
2. **Admin/User/Read-only roles and safeguards:** an **Admin** has
organization-wide authority over active Projects and organization security,
membership, lifecycle, governed, destructive, and recovery actions. A **User**
can perform ordinary product work, execute/cancel permitted work, and read
content-free audit history in every active Project in their Organization. A
**Read-only** actor can inspect evidence, results, and content-free audit history
in every active Project in their Organization. Users and Read-only actors cannot
manage organization security, lifecycle, membership, governed approvals, or
destructive/recovery actions. The database serializes transitions and prevents
removal or demotion of the final Admin; it also preserves the final active
Project User safeguard inherited from the compatibility manager record.
3. **No-accessible-Projects UX:** `/v1/me` returns the authenticated actor and
   an empty accessible-Project collection. The web app shows a deliberate empty
   workspace, never a fallback Project or organization-wide data. Only an
   organization owner sees the create-Project action; all product-data requests
   without an authorized explicit Project target fail safely.
4. **OTLP targeting:** direct OTLP ingestion requires one explicit
   `x-glasshouse-project-id` resource target. The server validates it against the
    authenticated actor, active Project, and organization-role policy before
   decoding/writing telemetry. OTLP resource attributes never establish scope;
   missing, conflicting, archived, or unauthorized targets are rejected.
   Internal server-originated ingestion uses the same validated scope, not a
   client-controlled default.
5. **Legacy PostgreSQL backfill:** migrations may backfill only records with a
   known organization and no Project to that organization's durable `default`
   Project, idempotently. Rows lacking an organization or a valid default
   Project cause the migration to fail loudly rather than be guessed into a
   tenant. Existing explicit Project relationships remain unchanged. Legacy
   ClickHouse ownership is never inferred.
6. **Archive and jobs:** authorized actors may read explicit archived-Project
   lifecycle/history detail, but archived Projects are excluded from ordinary
   selection and product-data reads. Archive blocks all new writes immediately.
   Queued/in-flight jobs must recheck active Project scope and the durable
   requesting Actor's current execute authority before claim, provider calls,
   persistence, tracing, completion, and restart recovery. Revoked, demoted,
    and historical jobs without a durable requester are cancelled safely with
    content-free lifecycle evidence; restore does not revive old jobs automatically.
     Provider work is admitted by a short, committed PostgreSQL transaction that
     records the requester, Project authorization epoch, and a bounded expiry.
      A second durable effect claim commits after validation and before each provider
      dispatch, trace, metric, result, or lifecycle-event write. Its identity is
      tenant-scoped by logical work item, effect, and explicit operation sequence,
      so it survives admission and worker-lease replacement. The effect-claim commit
      is the logical linearization point: revocation that wins first permits no call;
      a claim that wins first is cancelled and locally aborted by later revocation.
      No Project or membership lock is held while calling a provider. The claim is not
      physical atomicity with a provider or ClickHouse, so a recovery finding an
      existing provider or trace claim treats its remote outcome as unknown and never
      replays it; the work terminalizes safely without inventing a provider result.
7. **Audit policy:** lifecycle and membership audit records are append-only,
content-free PostgreSQL metadata. In strict mode they are visible to an Admin,
User, or Read-only actor only for an active, explicitly granted Project; archived
and deleting Project audit visibility is limited to the Admin lifecycle/recovery
scope. They are retained with the Project until the separately designed #49
governance retention policy takes effect; this issue adds no audit
deletion/export surface.
8. **Compatibility and strict enforcement:** migration `0041` records the
explicit mapping `owner -> Admin`, `manager -> User`, and `member -> Read-only`.
Conflicts resolve as `Admin > User > Read-only` through the effective-role query.
Malformed, cross-organization, orphaned, and unmapped legacy data is quarantined
and denied, never guessed or promoted. Every organization starts in compatibility
mode, preserving prior Basic Auth effective access; strict enforcement is enabled
    only by the documented, serialized operator action after the readiness query is
    clean. Strict mode never grants access beyond the legacy assignment.
9. **SSE frame delivery:** every authenticated SSE comment, snapshot, data,
     heartbeat, status, and error frame is serialized through a bounded current
      Project/membership revalidation fence. Detail-trace subscriptions apply the
      same count and encoded-byte cap while the ClickHouse snapshot is loading, and
      attach request cancellation before subscribing. Overflow, timeout, write error,
      backpressure, or client cancellation drops queued frames and closes or declines
      the stream before a later frame can be emitted.

## User audit log

`GET /v1/audit-events` and the authenticated `/audit-log` page expose a
read-only, newest-first view of existing, content-free user-action evidence.
Admin, User, and Read-only actors may use it. The server derives the
Organization and Actor from authentication on every request; it never accepts an
Organization or Project selector from the browser. An event with a Project is
returned only when the current Actor still has `audit_read` access to that
Project. Organization-wide events (for example, local authentication and
organization-role changes) are shared with every current durable Organization
role. Events for permanently deleted Projects cannot be shown because there is
no longer an authorized Project resource to inspect.

The endpoint combines only retained PostgreSQL records from the following
existing append-only ledgers: Project authorization and lifecycle, Dataset
lifecycle, Evaluation and Evaluation Gate lifecycle, governance, Admin access,
local authentication, prompt deletion, and user actions. The user-action ledger
currently covers prompt creation, prompt version creation, and the first durable
feedback record for an Actor/target. It presents the recorded timestamp,
safe Actor label (or `Unavailable`), action, resource type/ID, and a recorded
outcome when one exists. The inspectable detail is deliberately limited to the
ledger source. It does not return credentials, cookie/session material, token or
secret digests, raw prompt/Dataset/telemetry payloads, retention counts, request
contents, correlation IDs, or arbitrary audit JSON.

Coverage begins only when each respective ledger was introduced; the page does
not invent missing historical events, names, outcomes, or resource content.
Some actions have no outcome field and are displayed as unavailable. It is not
an internal operational-log surface and does not promise a complete record of
every historical platform operation.
Subject-only historical records whose `actor:<UUID>` value matches both a local
credential and a different Basic identity's canonical subject are displayed as
`Unavailable`, rather than guessing which Actor performed the action. Records
with a durable Actor ID do not have this ambiguity.

All time, Actor, action, resource, outcome, and free-text filters run in the
server-side visibility query over retained events, rather than over loaded
browser rows. The first request selects one PostgreSQL MVCC snapshot ordered by
`created_at`, event identifier, and source, all descending, preserving six-digit
UTC timestamps and deterministic ties. A transaction not committed when that
selection runs is excluded from the entire traversal, even if it commits before
a later page. Start a fresh traversal to see later commits; this is not a promise
that every transaction started before the first request will be included.

A multi-page result stores a short-lived copy of the allowlisted audit projection
in PostgreSQL; source audit ledgers are not changed. It is limited to 5,000
matching events, 1 MiB of serialized result data, and 5,000 Projects per
Organization. At most eight snapshots per Actor, 32 per Organization, and 128
globally may be live. Capacity or lock/statement failures may prevent a request;
narrow the filters or retry later. Expired entries are inaccessible after five
minutes and physically cleaned on subsequent snapshot allocation. One-page
results need no retained snapshot. These bounds can require multiple distinct
filtered traversals for larger histories; the API does not silently truncate.

The authenticated cursor binds the trusted Organization, Actor, canonical
filters, and snapshot position; changing only `limit` is permitted. Repeated
requests with the same cursor are retryable until expiry or invalidation. Each
request rechecks current authority under session, membership and Project fences;
role, local-credential and Project lifecycle changes invalidate affected
snapshots, including after a subsequent regrant or restoration. An invalid,
expired, cross-scope or changed-filter cursor returns 400; refresh to restart.
Format changes also invalidate old cursors. The UI rekeys filter results through
React Query, drops this authorization-sensitive cache after unmount, and
debounces filter input so an old scoped response cannot replace a newer view.

## In scope

### 1. Durable identity and authorization foundation

- Extend the trusted auth result with a stable authenticated actor subject and
  server-derived organization. Never accept actor or organization identity from
  headers, request bodies, query strings, telemetry attributes, or browser
  storage.
- Add monotonic PostgreSQL migrations for organization membership, Project
  membership/roles, project lifecycle state, and content-free lifecycle/audit
  records. Preserve organization-scoped composite-FK protections.
- Bootstrap the configured administrator as an Admin, safely for fresh and
  existing installations, while retaining only the legacy persistence mapping
  needed during compatibility.
- Implement centralized Admin/User/Read-only authorization helpers. Use safe
  non-enumerating responses for inaccessible cross-scope resources.

### 2. Project lifecycle contract

Add typed Zod/OpenAPI routes and generated clients for:

- actor identity and accessible Projects (`GET /v1/me`, `GET /v1/projects`);
- project creation, authorized detail, safe metadata update, archive, and
  restore;
- Admin-governed durable Actor role management.

`PATCH /v1/projects/{id}` accepts a non-empty subset of `name` and `slug`.
Names and slugs use the same validation as creation; slugs remain unique within
an organization, and a collision returns a content-free `409`. Project IDs are
immutable across metadata and lifecycle changes. `GET
/v1/projects/{id}/audit-events` exposes the Project's content-free lifecycle
and membership evidence only to organization owners and managers authorized for
that Project. Unauthorized Project targets return the same non-enumerating
response as other Project lifecycle routes.

Admins manage organization-scoped durable Actors through `GET
/v1/admin/actors` and `PUT /v1/admin/actors/{actorId}/role`. A role applies to
every Project in that Organization; no per-Project grant API exists. The API
uses durable actor UUIDs internally, returns usernames for human-facing labels,
preserves the final-Admin safeguard, and records content-free append-only audit
evidence. Legacy Basic Auth membership rows remain internal compatibility
projections and are not an administration surface.

Projects have stable IDs. Archive is non-destructive, removes a Project from
normal selection, and blocks new product-data writes until explicit restore.

### 3. Enforced Project scoping

Audit every supported API route, repository query, ClickHouse query, OTLP ingest
path, SSE subscription, worker claim, and recovery path. Each must authorize an
explicit Project target before use and bind both organization and Project in the
underlying data operation. Transactional mutations recheck the trusted actor's
current operation authorization while locking organization membership, Project
membership, the active Project row, and then its retained-audit UUID, rather than
relying on request admission alone. This order matches PostgreSQL membership updates,
which necessarily lock their row before their trigger can take the Project and audit
fences. New durable application/telemetry writes require a
valid Project ID. Legacy ClickHouse records without ownership remain unscoped
and are excluded from Project reads, streams, and retention; ownership is never
guessed.

### 4. Workspace UX

Make the Project selector an accessible workspace switcher with management
entry points. Persist selection only as actor/organization-scoped convenience
state, revalidate it through the server on login/credential change, and surface
a deliberate no-accessible-Projects state.

Every React Query key, request, cursor, mutation, invalidation, route detail,
and SSE URL must include Project scope. A switch cancels previous streams,
removes/invalidate previous view data, resets project-sensitive pagination and
filters, and never paints cached prior-Project rows while the next Project
loads.

### 5. Verification and operator documentation

- Add fresh-install and historical-upgrade migration coverage for bootstrap,
  constraints, membership, archive state, compatibility mapping, quarantine,
  strict-enforcement readiness, and idempotency.
- Seed at least two organizations and multiple Projects to prove isolation for
  each supported resource family, SSE, ClickHouse predicates, and job recovery.
- Add browser coverage for create/select/switch/archive/restore and no data
  leakage across traces, spans, prompts, datasets, evaluations, feedback, and
  live updates.
- Update roadmap, glossary, API/setup docs, and an operator runbook with the
  tenancy, membership, project selection, archive, migration, and recovery
  contract.

## Non-goals / deferred scope

No SSO, SCIM, OAuth/social login, invitation email, password reset, custom RBAC
engine, billing, team hierarchy, cross-organization collaboration, organization
aggregate fallback, hard Project deletion, legacy telemetry ownership guessing,
or governance/Agent Registry implementation. #49 owns retention/redaction
policy semantics; #50 owns Agent/manifest behavior, and both must consume this
contract.

## Implementation order

1. **Foundation:** auth actor contract, migrations/bootstrap/constraints,
   membership authorization helpers, and migration tests.
2. **Project API:** lifecycle and membership routes, generated contracts, and
   exhaustive authorization tests.
3. **Scope audit:** repository/API/ClickHouse/SSE/worker enforcement and
   two-organization regression matrix.
4. **Workspace UX:** validated selector and management UI; Project-aware query
   cache/SSE lifecycle; browser isolation tests.
5. **Release:** operator documentation, full verification, security review,
   ready PR, and hosted CI.

## Delivery rules

The factory must keep all implementation in one authoritative run and must not
recursively invoke `feature-factory factory start`. It must not use client
supplied tenancy metadata as authority or make any new product write unscoped.
Do not create a PR until migrations, generated contracts, targeted isolation
coverage, security review, and the repository's relevant quality gates have
real evidence.
