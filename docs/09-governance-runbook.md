# Governance policy runbook

## Scope and safety

Governance is project-scoped. The API derives organization and actor from Basic Auth and verifies active project manager or organization-owner access; callers cannot supply trusted organization metadata. Drafts never change runtime behavior. No retention can run without an approved immutable policy version.

The first policy contract is deliberately narrow:

- Retention supports `traces`, `datasets`, and `feedback`, each with a whole-day interval from 1 to 3650 days.
- Ingress redaction supports `all_text` for trace input/output and literal metadata attribute key replacement. Attribute keys are validated, sorted, and deduplicated.
- Redaction is applied during OTLP normalization before ClickHouse persistence, logging, events, SSE, and audit data. Existing `astraea.prompt.*` stripping remains in force.
- No retroactive rewrite, arbitrary patterns, ML redaction, RBAC changes, or automated approval is provided.

## Operator workflow

1. Select the project in the UI and open **Governance**.
2. Create a draft with the desired intervals and redaction mode. Review the immutable version/history metadata.
3. Explicitly approve the draft. The latest approved immutable version is effective; prior approved versions remain as audit history.
4. Run **Preview eligible counts**. It reports only class counts, not record contents. The resulting approved policy version is bound to the run request; a newer approval requires a new preview.
5. Run one bounded batch. PostgreSQL deletion batches are capped at 500 rows; the UI uses 100. ClickHouse trace/observation mutations are restricted by organization and project and wait for completion.
6. Review the safe run summary and server events (`governance.retention_completed`). Audit records contain actor, project/version IDs, counts, and duration only.

## Recovery and evidence

Retention commits its `running` run and start audit record before any ClickHouse mutation, then records bounded stage/count evidence separately before terminalization. Startup deterministically terminalizes interrupted runs with a failure audit record; review its run/audit record, correct infrastructure, then issue a new run. Deletion predicates are time-based and project-scoped, so reruns are idempotent for already-deleted records. Historical ClickHouse rows without ownership are never selected or attributed.

## Inventory

The governed inventory currently covers ClickHouse traces/observations and PostgreSQL datasets/dataset items and feedback review records. Prompt, experiment, benchmark, and score retention remain excluded until their dependency ordering and recovery contracts are explicitly designed; no implicit deletion occurs for them.
