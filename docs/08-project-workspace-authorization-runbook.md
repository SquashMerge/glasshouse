# Project workspace authorization runbook

## Bootstrap

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

Migrations `0043_authorization_revocation_fence.sql`,
`0044_execution_admission_cancellation.sql`, and
`0045_execution_admission_effect_claims.sql` serialize Project and organization
membership changes with authorization-sensitive work. Authorization paths lock
organization membership, Project membership, then the Project row: PostgreSQL
membership updates necessarily acquire their row lock before trigger code can
take the Project fence, so this shared order prevents an inverse-order deadlock.
An execution admission is committed under that short fence with the current
Project epoch, requester, and expiry. After validation, a provider dispatch and
each trace, metric, result, or lifecycle-event write commits its own bounded
effect claim under the same fence. That committed claim is the logical admission
linearization point: if revocation/archive wins first, no provider or writer is
called; if a claim wins first, revocation cancels the admission, its claims, and
local work. Do not hold a database authorization lock during a provider call.

Every authenticated SSE frame, including connection comments, snapshots, data,
heartbeats, statuses, and errors, takes a new bounded authorization fence through
write settlement. `SSE_FRAME_WRITE_TIMEOUT_MS` defaults to 5000 ms (accepted
range 100-60000 ms); `SSE_MAX_PENDING_FRAMES` defaults to 32 (1-256), and
`SSE_MAX_PENDING_BYTES` defaults to 65536 (1024-1048576). The active write counts
toward both queue limits; overflow, timeout, write error, backpressure, or
disconnect closes the stream, drops all queued frames, and releases the fence.
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
