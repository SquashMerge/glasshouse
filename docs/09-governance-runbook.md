# Governance policy runbook

## Scope and safety

Governance is project-scoped. Every Project is provisioned with an immutable, automatically approved baseline (traces 30 days, datasets 90 days, feedback 90 days, and ingress redaction `none` with no keys). The API derives organization and actor from Basic Auth and verifies active project manager or organization-owner access; callers cannot supply trusted organization metadata. Project-specific approved policies remain effective, and existing drafts remain immutable history when the baseline is provisioned. Drafts never change runtime behavior. No retention can run without an approved immutable policy version, and provisioning the baseline never starts a retention run.

The first policy contract is deliberately narrow:

- Retention supports `traces`, `datasets`, and `feedback`, each with a whole-day interval from 1 to 3650 days.
- Ingress redaction supports `all_text` for trace input/output and literal metadata attribute key replacement. Attribute keys are validated, sorted, and deduplicated.
- Redaction is applied during OTLP normalization before ClickHouse persistence, logging, events, SSE, and audit data. Existing `glasshouse.prompt.*` stripping remains in force.
- No retroactive rewrite, arbitrary patterns, ML redaction, or RBAC changes are provided. The only automated approval is the audited baseline provisioned for Projects without an approved policy.

## Operator workflow

1. Select the project in the UI and open **Governance**.
2. Create a draft with the desired intervals and redaction mode. Review the immutable version/history metadata.
3. Explicitly approve the draft. The latest approved immutable version is effective; prior approved versions remain as audit history.
4. Run **Preview eligible counts**. It reports only class counts, not record contents, and issues a single-use, 15-minute server authorization bound to the manager, project, and current approved version. A newer approval requires a new preview.
5. Run one bounded batch. PostgreSQL deletion batches are capped at 500 rows; the UI uses 100. ClickHouse counts trace groups, not physical rows: each selected group is wholly pre-cutoff and the entire trace/observation mutation is capped at the requested physical-row budget. Oversized trace groups are skipped and reported.
6. Review the safe run summary and server events (`governance.retention_completed`). Audit records contain actor, project/version IDs, counts, and duration only.

## Dataset lifecycle

- Dataset export, restore, and tombstone require a Project Admin. Export supports only redacted, project-scoped CSV or JSONL for an explicitly selected draft or immutable version. It preserves safe provenance identifiers and is rejected before response generation above 500 items or 1,048,576 bytes.
- Archive is the normal retirement path. Restore and metadata/lifecycle mutations require the current quoted ETag revision. A `409` includes the current revision and field-level diff; refresh and make an explicit retry decision. Do not retry by merging values automatically.
- Tombstone is a hard deletion with a typed Dataset-slug confirmation. It is prohibited while an immutable version, historical/queued/scheduled run, active Dataset retention hold, benchmark link, or feedback link remains. The tombstone reserves the slug after deletion. Use the conflict counts to resolve or retain dependencies; do not remove historical evidence to make a Dataset deletable.
- Retention does not delete Datasets with immutable versions or active Dataset retention holds. This intentionally favors explainable historical execution over automatic content removal.

## Recovery and evidence

Retention commits its `running` run and start audit record before any external mutation. Every destructive stage holds the active-project/manager lock while it rechecks the effective policy and commits stage evidence; approval, archival, and membership changes use the same project lock. Any retained-audit operation locks memberships, then Project rows, then the Project audit UUID; startup finalization first locks the Project/run rows before its audit UUID. Startup deterministically terminalizes every interrupted run with one failure audit record; review its run/audit record, correct infrastructure, then issue a new run. Deletion predicates are time-based and project-scoped, so reruns are idempotent for already-deleted records. Historical ClickHouse rows without ownership are never selected or attributed.

## Inventory

The governed inventory currently covers ClickHouse traces/observations and PostgreSQL datasets/dataset items and feedback review records. Prompt, experiment, benchmark, and score retention remain excluded until their dependency ordering and recovery contracts are explicitly designed; no implicit deletion occurs for them.
