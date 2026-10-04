# Project workspace authorization runbook

## Bootstrap

The Basic bootstrap below is the default `ASTRAEA_AUTH_BOOTSTRAP_MODE=basic`
compatibility path. For intentional local-first installations, set the mode to
`local` before migrating and follow the [local credential/bootstrap runbook](local-credentials-runbook.md).
Migration 0098 preserves all existing Basic authorization and closes local setup
when an Admin already exists. The new local storage/service slice supplies no
login/session endpoints or setup UI yet.

Set `ASTRAEA_BOOTSTRAP_OWNER_USERNAME` to exactly one username in the configured
Basic Auth credentials. The named credential's organization and exactly one active
`default` Project must already exist. `bun run db:migrate` applies SQL migrations,
then atomically grants that actor organization-owner and default-Project-manager
roles. Startup fails rather than inventing an organization or Project when this
precondition is not met.

Changing the bootstrap username grants the new named actor access; it never removes
the previous owner. A failed migration or bootstrap leaves the API unavailable.
Correct the credential/configuration or provision the organization/default Project,
then rerun `bun run db:migrate`.

## Admin/User/Read-only rollout

Migration `0041_admin_user_read_only_authorization.sql` is additive and leaves
every organization in compatibility mode. It records the explicit legacy mapping:
organization `owner` becomes **Admin**; Project `manager` becomes **User**; and
Project `member` becomes **Read-only**. Conflicting valid assignments resolve to
the most privileged effective role. Missing, malformed, orphaned, or
cross-organization records are quarantined and denied; do not guess a replacement
identity or grant it an Admin role.

Existing Basic Auth deployments retain their prior effective access while
compatibility mode is active. Do not enable strict enforcement as part of a normal
migration rollout. For each organization, an operator must first inspect the
idempotent readiness result:

```sql
SELECT * FROM authorization_role_migration_readiness('<organization-uuid>');
```

Repair the underlying legacy identity/membership data, record the completed
content-free quarantine review with `resolved_at`, and repeat the readiness query
until `unresolved_quarantine_count = 0` and `has_admin = true`. Then deliberately
enable strict enforcement in a transaction through the idempotent database action:

```sql
SELECT enable_admin_user_read_only_enforcement('<organization-uuid>');
```

The function locks the organization and policy row, rechecks unresolved quarantine
records and valid Admin presence, and records `enabled_at`. Repeating it is safe.
Strict mode denies invalid/unmapped legacy access and never grants access broader
than the original valid legacy assignment. Do not remove or demote the final
Admin; the database serializes and rejects that transition.

Migration `0042_experiment_requester_authorization.sql` records the durable
requesting Actor for new experiments and cancels pending/running historical
experiments that have no trustworthy requester. When a User is demoted to
Read-only or removed from a Project, their queued and in-flight experiments stop
at the next authorization gate: they cannot be claimed, invoke a provider,
persist a result, write an evaluation trace, complete, or resume after restart.
No manual replay is required or supported for these cancelled runs; submit a new
experiment after restoring appropriate execute access.

## Admin access and break-glass recovery

Migration `0051_admin_membership_project_grants_recovery.sql` makes durable Actor
IDs the administration and authorization source of truth. The `/access` dashboard
and `/v1/admin/*` endpoints are Admin-only: they list every organization-scoped
durable actor, set only **Admin**, **User**, or **Read-only** organization roles,
and list, set, or revoke explicit **User** or **Read-only** grants for active
same-organization Projects. The API never accepts a username, email, IdP claim,
or caller-selected organization as the authorization subject. Basic Auth subjects
remain a compatibility projection and are never returned by this administration
surface. Admins hold organization-wide authority; User and Read-only actors have
only their explicit active-Project grants. A Read-only organization role is a
ceiling: it cannot receive or retain a User-level Project grant.

The existing `ASTRAEA_BOOTSTRAP_OWNER_USERNAME` credential is the only supported
break-glass authority. It must match exactly one configured Basic Auth credential
for the authenticated organization and its deterministic durable Actor ID. No
emergency password, token, or secret is created, stored, logged, returned, or sent
to the dashboard. `POST /v1/admin/recovery` requires the exact confirmation
`RESTORE ADMIN`, succeeds only when the organization has no active Admin, and
cannot select or cross into another organization. Every success, denial, and
cooldown decision is append-only and content-free, recording only durable actor,
organization/Project scope, action, correlation UUID, and timestamp. Attempts have
a durable 15-minute cooldown, including denied attempts, so an operator must wait
for expiry before retrying. Rotate or revoke the configured Basic Auth owner only
through deployment-secret configuration and a deliberate replacement Admin flow;
never create an application-side recovery credential.

The database rejects removal, demotion, and identity unlinking of the final active
Admin. Administration mutations lock compatibility membership rows, durable role
and Project-grant rows, Project rows, and audit UUIDs in that order; retries occur
only before mutation code begins. Do not bypass these guards for fixtures or manual
repair. Inspect `/v1/admin/audit-events` for content-free access evidence.

Migrations `0043_authorization_revocation_fence.sql` through
`0048_project_audit_lock_order.sql` serialize Project and organization membership
changes with authorization-sensitive work. The global physical order is organization
membership rows, Project membership rows, Project rows, then Project audit-provenance
advisory locks, each collection ordered by its stable key. Authorization is decided
only after its membership and Project rows are locked. PostgreSQL automatically
acquires the target membership-row lock before the membership `BEFORE ROW` trigger
runs; that trigger locks every affected Project and its audit UUID before it fences
admitted work. Default-project, deletion, retention, bootstrap, and audit-trigger
paths follow the same order; a deleted Project has no row left to lock, so its
retained audit UUID is the final fence. This prevents advisory/membership inversions.
Lock-phase `40P01` and `40001` retries run before a route mutation begins; an audit
insert, provider/effect claim, or other mutation is never replayed by that retry.
An execution admission is committed under that short fence with the current
Project epoch, requester, and expiry. After validation, a provider dispatch and
each trace, metric, result, or lifecycle-event write commits its own bounded
effect claim under the same fence. That committed claim is the logical admission
linearization point: if revocation/archive wins first, no provider or writer is
called; if a claim wins first, revocation cancels the admission, its claims, and
local work. Do not hold a database authorization lock during a provider call.

Migration `0047_durable_execution_effects.sql` makes an effect identity durable at
the tenant-scoped logical work-item level, not at the short-lived admission level.
Provider dispatches use one stable logical key; GEPA/LiteLLM derives deterministic
per-call sequence keys below it so separate metric/evaluation calls remain distinct.
OpenAI-compatible calls receive the same stable key in both idempotency and client
request-ID headers. A recovery that finds a pre-existing provider-dispatch key must
not call a provider again because the earlier remote outcome is unknown: experiment
work is terminalized as a failed item with no invented output or score, and an
optimization job is terminalized as failed. Trace effects use the same no-replay
rule, so an unknown prior trace is not written twice.

Every authenticated SSE frame, including connection comments, snapshots, data,
heartbeats, statuses, and errors, takes a new bounded authorization fence through
write settlement. `SSE_FRAME_WRITE_TIMEOUT_MS` defaults to 5000 ms (accepted
range 100-60000 ms); detail-trace snapshot acquisition uses the same bound.
`SSE_MAX_PENDING_FRAMES` defaults to 32 (1-256), and `SSE_MAX_PENDING_BYTES`
defaults to 65536 (1024-1048576). The active write and the pre-snapshot trace-detail
queue count toward their respective limits; overflow, timeout, write error,
backpressure, or disconnect drops queued frames and closes or declines the stream.
`EXECUTION_ADMISSION_TIMEOUT_MS` defaults
to 30000 ms (accepted range 1000-300000 ms) and
`EXECUTION_ADMISSION_POLL_MS` defaults to 250 ms (accepted range 50-5000 ms).
These limits bound Astraea-side cancellation. The effect claim is a logical
PostgreSQL decision, not a distributed transaction: a provider or ClickHouse
write whose claim committed before revocation can still have a remote side effect.
PostgreSQL cannot undo that request, but Astraea cancels local work and suppresses
all effects that have not already won their own claim.

## Operations

In strict mode, use Admins to create Projects, change the organization default,
permanently delete non-default Projects, manage organization members, perform
lifecycle/recovery actions, and approve governed/destructive work. Users may do
ordinary product work and executions only in granted active Projects. Read-only
actors may inspect granted active Project evidence and content-free audit history;
they cannot write, execute, ingest, cancel, approve, promote, delete, or change
membership/security state. Archive is non-destructive and blocks product reads,
writes, subscriptions, and direct OTLP. Restore does not resume old jobs.

Project list and current-actor responses include server-authoritative
`can_manage` and `can_govern` capabilities. The dashboard must use those fields
rather than inferring controls from a displayed role: a compatibility-mode
legacy Project manager is an effective User but retains its legacy management
and governance controls until strict enforcement is enabled.

The default Project is server-authoritative. A stale browser selection never overrides it at
login. To delete a Project, first select another active same-organization Project as default,
then submit the exact current Project name. The API serializes the default/delete decision,
cascades Project-owned relational rows, and preserves only content-free lifecycle audit facts.

## OTLP

Every direct request to `POST /v1/otel/v1/traces` needs one
`x-astraea-project-id` header for an active Project the Basic-auth actor can access.
Resource attributes may match that target but never select it. Missing, conflicting,
archived, or inaccessible IDs are rejected without disclosing cross-workspace data.
