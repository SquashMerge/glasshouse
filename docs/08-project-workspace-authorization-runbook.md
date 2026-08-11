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

Migration `0043_authorization_revocation_fence.sql` serializes Project and
organization membership role changes with authorization-sensitive writes. A
mutation locks its Project before freshly locking and checking the acting
membership; a demotion or removal takes the same Project fence first. Provider
admission holds that fence through invocation, and result/trace persistence is
admitted again, so role revocation waits for an in-progress admission or blocks
the later action without a write or trace.

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
