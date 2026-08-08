# Project workspace authorization contract

**Implementation brief for [#51](https://github.com/dsarlo/astraea/issues/51)**

## Purpose

Establish the smallest durable, server-enforced organization actor and Project
membership boundary that lets Astraea safely isolate all product data by the
selected Project. This is a prerequisite for #49 governance and #50 Agent
Registry work.

A browser-selected `project_id` is a resource target only. It never creates
organization identity or authorization: the server derives the actor and
organization from the trusted authentication result and validates access before
any read, write, query, event subscription, or background recovery action.

## Existing baseline

The API currently uses Basic Auth and already has organization-owned Projects,
a `trustedTenant` helper, and a middleware check for selected project IDs.
Existing product routes commonly accept `project_id`, but the authenticated actor
and durable Project-membership model, lifecycle APIs, end-to-end authorization
matrix, and Project-switch cache/SSE guarantees are incomplete.

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
2. **Minimal roles and safeguards:** an organization owner may create Projects
   and manage organization-level membership. A Project manager may manage only
   their Project's metadata, archive/restore state, and Project membership. A
   Project member can use product data only within that Project. The final
   organization owner cannot be removed or demoted, and the final active
   Project manager cannot be removed or demoted while the Project remains
   active; an owner can add/reassign a manager first.
3. **No-accessible-Projects UX:** `/v1/me` returns the authenticated actor and
   an empty accessible-Project collection. The web app shows a deliberate empty
   workspace, never a fallback Project or organization-wide data. Only an
   organization owner sees the create-Project action; all product-data requests
   without an authorized explicit Project target fail safely.
4. **OTLP targeting:** direct OTLP ingestion requires one explicit
   `x-astraea-project-id` resource target. The server validates it against the
   authenticated actor, active Project membership, and organization before
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
   Queued/in-flight jobs must recheck active Project scope before claim and
   persistence, then cancel/fail safely with content-free lifecycle evidence;
   restore does not revive old jobs automatically.
7. **Audit policy:** lifecycle and membership audit records are append-only,
   content-free PostgreSQL metadata visible only to organization owners and
   authorized managers of the relevant Project. They are retained with the
   Project until the separately designed #49 governance retention policy takes
   effect; this issue adds no audit deletion/export surface.

## In scope

### 1. Durable identity and authorization foundation

- Extend the trusted auth result with a stable authenticated actor subject and
  server-derived organization. Never accept actor or organization identity from
  headers, request bodies, query strings, telemetry attributes, or browser
  storage.
- Add monotonic PostgreSQL migrations for organization membership, Project
  membership/roles, project lifecycle state, and content-free lifecycle/audit
  records. Preserve organization-scoped composite-FK protections.
- Bootstrap the configured administrator as organization owner and as a manager
  of the existing default Project, safely for fresh and existing installations.
- Implement narrow owner / Project-manager / Project-member authorization
  helpers. Use safe non-enumerating responses for inaccessible cross-scope
  resources.

### 2. Project lifecycle contract

Add typed Zod/OpenAPI routes and generated clients for:

- actor identity and accessible Projects (`GET /v1/me`, `GET /v1/projects`);
- project creation, authorized detail, safe metadata update, archive, and
  restore;
- owner/manager-governed Project membership management.

`PATCH /v1/projects/{id}` accepts a non-empty subset of `name` and `slug`.
Names and slugs use the same validation as creation; slugs remain unique within
an organization, and a collision returns a content-free `409`. Project IDs are
immutable across metadata and lifecycle changes. `GET
/v1/projects/{id}/audit-events` exposes the Project's content-free lifecycle
and membership evidence only to organization owners and managers authorized for
that Project. Unauthorized Project targets return the same non-enumerating
response as other Project lifecycle routes.

Organization owners manage the organization membership directory through
`GET /v1/organization/members` and `PUT` or `DELETE
/v1/organization/members/{actor}`. Deletion preserves the database
final-owner safeguard and is audited; an actor with Project memberships must be
removed from those Projects before organization membership deletion.

Projects have stable IDs. Archive is non-destructive, removes a Project from
normal selection, and blocks new product-data writes until explicit restore.

### 3. Enforced Project scoping

Audit every supported API route, repository query, ClickHouse query, OTLP ingest
path, SSE subscription, worker claim, and recovery path. Each must authorize an
explicit Project target before use and bind both organization and Project in the
underlying data operation. New durable application/telemetry writes require a
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
  constraints, membership, archive state, and idempotency.
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
