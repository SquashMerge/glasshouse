# Evaluation Run Evidence

Evaluation Runs are inspectable records, not opaque pass percentages. A Run pins the Definition Version, Dataset Version, sampled item identity, target, evaluator, execution defaults, thresholds, and limits before dispatch. The status and evidence APIs expose those pins plus bounded per-item evidence.

## Evidence and retention

`GET /v1/evaluation-runs/{id}?project_id=...` returns the run summary and a bounded first evidence page. Use `GET /v1/evaluation-runs/{id}/evidence?project_id=...&limit=...&offset=...` for deterministic `position, task_id` pagination. Evidence includes task lifecycle, final result/error, evaluator rationale, cost, timing, source provenance, evaluation trace linkage, and redaction metadata. Cancelled or failed items remain visible even when no result row exists.

Evidence is read-time bounded. Sensitive-key redaction and size/depth limits always apply; the approved Project governance redaction policy adds its configured keys or all-text mode. A redaction indicator identifies fields affected and the byte bound. Do not treat the SSE event stream as an evidence page.

## Comparison rules

`POST /v1/evaluation-runs/compare?project_id=...` with two distinct Run IDs reports every pinned difference. Target changes are explicit and are allowed for baseline/candidate comparison. The immutable Definition Version and Dataset Version content hashes, evaluator contract, execution defaults, sample identity, and thresholds must match. Legacy or unsupported evaluator contracts are not comparable.

Both Runs must be completed before score, cost, or duration deltas are emitted. Failed, cancelled, pending, or running Runs remain inspectable but return `non_success_terminal` with a null delta. Input mismatches return `incompatible_inputs`; unsupported contracts return `unsupported_contract`. A comparable delta is observational evidence and does not establish causal improvement.

## Baseline evaluators

The shipped deterministic evaluator contracts are `exact_match` and `contains`, version `v1`. JSON paths are pinned in the evaluator definition. Missing expected or actual paths score `0`; they never accidentally count as an exact match. Rationale records the evaluator kind/version, resolved paths, expected and actual values, score, and match result, subject to evidence bounds and redaction.

The configured-LLM target pins provider (`openai` or `codex_cli`), model, prompt, and execution defaults. Provider output is bounded before result persistence. Provider failures are classified by the durable execution path; unknown dispatch outcomes are not silently retried.

## Legacy Runs

Runs created before the durable evidence contract may be readable through compatibility paths but lack the pinned evidence required for comparison. Treat them as inspectable legacy data, not reproducible baseline/candidate evidence.
