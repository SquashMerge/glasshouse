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

## Operations

Use organization owners to create Projects, change the organization default, permanently
delete non-default Projects, and manage organization members. Project managers may rename,
archive/restore, and grant Project membership. The final
organization owner and final manager of an active Project cannot be removed or
demoted. Archive is non-destructive and blocks product reads, writes, subscriptions,
and direct OTLP. Restore does not resume old jobs.

The default Project is server-authoritative. A stale browser selection never overrides it at
login. To delete a Project, first select another active same-organization Project as default,
then submit the exact current Project name. The API serializes the default/delete decision,
cascades Project-owned relational rows, and preserves only content-free lifecycle audit facts.

## OTLP

Every direct request to `POST /v1/otel/v1/traces` needs one
`x-astraea-project-id` header for an active Project the Basic-auth actor can access.
Resource attributes may match that target but never select it. Missing, conflicting,
archived, or inaccessible IDs are rejected without disclosing cross-workspace data.
