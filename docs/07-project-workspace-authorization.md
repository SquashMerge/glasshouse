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
