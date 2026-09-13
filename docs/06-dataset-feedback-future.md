# Dataset, Evaluation, and Feedback Future Design

The shipped foundation provides versioned project Datasets, configured-LLM Evaluation Runs with bounded evidence/comparison/gates, and immutable `human.feedback` signals with a review workflow. It never changes a Dataset, evaluation gate, prompt, model, evaluator, or deployment automatically from feedback.

## Dataset and evaluation lifecycle

Dataset drafts/versions, content hashes, lifecycle, version-pinned Runs, and reusable Evaluation Definitions are shipped. Deeper Python/TypeScript SDK conveniences, schedules, and future product ergonomics remain deferred.

## Execution and evaluators

An Agent Registry with manifest versions and HTTP execution is deferred. The shipped introspection contract is client-reported supplementary evidence only, not framework integration. Custom, LLM-as-judge, code, RAG, and calibrated evaluators; schedules; protected environments; and version-aware analysis remain future work.

## Feedback maturity

Identity, RBAC, per-user current votes, ownership, assignment, multi-review approval, and a content-free audit ledger are future work. Dataset candidates, curator promotion, feedback-to-version lineage, and protected-by-run indicators are also future work; current explicit case creation inserts directly into an existing Dataset.

PII/secret redaction workflows, retention/deletion controls, evidence snapshots, and policy approvals must precede broader data governance. Exact and semantic deduplication, clustering, priority models, similarity search, alerts, and cross-run failure analysis are not in the first pass. Judge calibration, training/fine-tuning exports, and any automatic model, evaluator, Dataset, evaluation-gate, or deployment mutation remain explicitly out of scope. The sole current prompt exception is GEPA system-prompt promotion after held-out validation, leakage checks, and a source-version guard; all other prompt candidates remain review-required or blocked.
