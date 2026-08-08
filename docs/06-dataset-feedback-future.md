# Dataset, Evaluation, and Feedback Future Design

The first pass deliberately provides mutable project Datasets, configured-LLM Experiment runs, and immutable `human.feedback` signals with a small review workflow. It never changes a Dataset, evaluation gate, prompt, model, evaluator, or deployment automatically from feedback.

## Dataset and evaluation lifecycle

Future Dataset contracts include immutable versions, mutable drafts, protected labels, content hashes, diffs, rollback, and version-pinned evaluation runs. Dataset items will later gain revisions/editing, import/export, schemas, ownership, archive/tombstones, and CI-only version pins. Reusable Evaluation Definitions, default Dataset selectors, definition/version history, and deeper Python/TypeScript SDK conveniences remain deferred.

## Execution and evaluators

An agent registry with manifest versions, framework introspection, and HTTP execution is deferred. So are custom, LLM-as-judge, code, RAG, and calibrated evaluators; comparisons, schedules, CI gates, protected environments, baselines, and version-aware analysis.

## Feedback maturity

Identity, RBAC, per-user current votes, ownership, assignment, multi-review approval, and a content-free audit ledger are future work. Dataset candidates, curator promotion, feedback-to-version lineage, and protected-by-run indicators are also future work; current explicit case creation inserts directly into an existing Dataset.

PII/secret redaction workflows, retention/deletion controls, evidence snapshots, and policy approvals must precede broader data governance. Exact and semantic deduplication, clustering, priority models, similarity search, alerts, and cross-run failure analysis are not in the first pass. Judge calibration, training/fine-tuning exports, and any automatic model, evaluator, Dataset, evaluation-gate, or deployment mutation remain explicitly out of scope. The sole current prompt exception is GEPA system-prompt promotion after held-out validation, leakage checks, and a source-version guard; all other prompt candidates remain review-required or blocked.
