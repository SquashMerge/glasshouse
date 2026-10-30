# Evaluation release and CI gates

Evaluation Gates are administrator-approved, project-scoped admissions for a single immutable Evaluation Definition Version. They are intended for release operators and CI integrations that need a deterministic pass/fail result without re-resolving a mutable draft or `latest` pointer.

## Approval lifecycle

An Admin creates an approval with:

- `definition_version_id` — an explicit immutable Definition Version UUID;
- `gate_context` — `ci` or `release`;
- a short operator reason.

The server resolves and stores the Definition Version's immutable content hash, its exact Dataset Version UUID and content hash, and the typed `minimum_pass_rate`. A version without a complete v1 contract, an explicitly configured provider/model, or a pinned minimum pass rate cannot be approved. Gate approval never resolves missing target fields from runtime environment defaults. Approval records are immutable except for one-way revocation and supersession. A superseding approval must bind the same Definition Version and context; the prior approval is marked `superseded` in the same transaction.

Approval responses include `definition_contract`: `v1` for an evaluator supported by the current safety policy, or `legacy_incompatible` for a historical evaluator that no longer satisfies it. This classification is independent of approval status: an approval can remain `active` for inspection and revocation while its Definition Version is no longer executable. The UI disables Run gate for incompatible approvals, and server-side admission rejects new work from them. Publish a safe replacement Definition Version and approve that version; historical contents and hashes remain unchanged. Idempotent replay of an already admitted Run still returns its durable record.

Approval and invocation writes require the project-scoped Admin-only `release_gate_manage` operation. Read-only inspection is project-scoped `product_read`. A User, Read-only actor, cross-project caller, archived project, or revoked authorization cannot approve, revoke, or invoke a gate.

## API contract

All routes require `project_id` and use project authorization:

- `POST /v1/evaluation-gates/approvals` — create an approval;
- `GET /v1/evaluation-gates/approvals` — list active approvals, or include revoked/superseded records with `include_revoked=true`;
- `GET /v1/evaluation-gates/approvals/{id}` — inspect one approval;
- `GET /v1/evaluation-gates/approvals/{id}/history` — inspect its content-safe, project-scoped audit history;
- `POST /v1/evaluation-gates/approvals/{id}/revoke` — revoke an active approval;
- `POST /v1/evaluation-gates/runs` — invoke a gate;
- `GET /v1/evaluation-gates/runs` and `/v1/evaluation-gates/runs/{id}` — inspect machine-readable results.

Invocation requires a JSON request body, an `Idempotency-Key` header, and all pinned identifiers: approval, Definition Version, Dataset Version, and gate context. The admission transaction re-checks those values against the still-active approval while holding the approval and active Project locks. This prevents a revoked approval or a mutable/latest selector from admitting new work. Retries with the same key replay the same durable gate Run; a changed payload conflicts.

## Gate outcomes

A gate Run is linked to exactly one durable Evaluation Run and stores the pinned hashes, target/evaluator fingerprints, threshold, actor, context, and idempotency key. No Dataset item, provider response, prompt, secret, or protected evidence payload is stored in the gate audit table.

When the Evaluation Run reaches a terminal state, the database records one outcome audit event:

- `passed` — completed evidence pass rate meets the approved minimum;
- `failed` — completed evidence is below the minimum;
- `inconclusive` — the Run completed without completed evidence;
- `error` — the Evaluation Run failed;
- `cancelled` — the Evaluation Run was cancelled.

The result is deterministic and content-safe. Detailed redacted evidence remains available through the existing Evaluation Run evidence endpoint, subject to its project policy and bounds.

## CI usage

A CI integration should approve a Definition Version out of band, retain the approval ID and the exact two version IDs, invoke with a unique idempotency key, and poll `GET /v1/evaluation-gates/runs/{id}` until the status is terminal. Treat `passed` as success. Treat `failed`, `inconclusive`, `error`, and `cancelled` as a non-passing gate and include `outcome_reason` in the machine-readable report. Never substitute a current draft or resolve a version by name at gate time.
